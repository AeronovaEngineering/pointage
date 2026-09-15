import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FichePaie, moisLabel } from "@/lib/fiche-paie";
import { formatMinutesEnHeures } from "@/lib/format";

interface EmployeeInfo {
  nom?: string | null;
  prenom?: string | null;
  poste?: string | null;
  departement?: string | null;
  cni?: string | null;
  num_secu?: string | null; // N° CNSS
  date_embauche?: string | null;
  type_contrat?: string | null;
  mode_paiement?: string | null; // Virement, Chèque, Espèce
  categorie?: string | null;
  situation_familiale?: string | null;
  nombre_enfants?: number | string | null;
}

interface CompanyInfo {
  name?: string;
  logoDataUrl?: string;
}

const DT = (n: number) => `${n.toFixed(2)} DT`;
const NUM = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// Brand palette — black & gold, no blue anywhere.
const BLACK: [number, number, number] = [23, 23, 23];
const GOLD: [number, number, number] = [176, 137, 62];
const GOLD_LIGHT: [number, number, number] = [232, 219, 189];
const GOLD_FAINT: [number, number, number] = [248, 244, 236];
const GRAY: [number, number, number] = [120, 120, 120];
const INK: [number, number, number] = [40, 40, 40];

// Hardcoded company identity — to be wired into CompanyInfo later.
const COMPANY = {
  name: "AERONOVA ENGINEERING",
  adresse: "N°47 Rue Fathi Zouhir Cité Nkhilette 2083 Raoued Ariana-Tunisie",
  mf: "1919265 L/A/M/000",
  cnssEmployeur: "696028 - 53",
};

function sectionTitle(doc: jsPDF, label: string, x: number, y: number, width: number) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...BLACK);
  doc.text(label.toUpperCase(), x, y);
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.6);
  doc.line(x, y + 2, x + width, y + 2);
}

/**
 * Resolve the "Nombre" column for a given rubrique based on its label.
 * Returns undefined when the rubrique has no meaningful count.
 */
function resolveNombre(label: string, fiche: FichePaie): number | undefined {
  const l = label.toLowerCase();

  if (l.includes("absence")) return fiche.jours_absence;
  if (l.includes("supplémentaire") || l.includes("heure sup") || l.includes("heures sup"))
    return fiche.heures_supplementaires;
  if (l.includes("férié") || l.includes("majoré")) return fiche.jours_feries_travailles;
  if (l.includes("présence") || l.includes("travaillé") || l.includes("base")) return fiche.jours_travailles;

  return undefined;
}

/**
 * Resolve the "Taux" column for a given rubrique from the rates persisted
 * on the fiche itself (computed once in SQL) — never re-derived from
 * montant / nombre, which used to silently paper over whatever divisor the
 * backend actually used (the "salaire ÷ jours_travailles instead of ÷30"
 * bug). Returns undefined when the rubrique has no single applicable rate
 * (e.g. Primes).
 */
function resolveTaux(label: string, fiche: FichePaie): number | undefined {
  const l = label.toLowerCase();

  if (l.includes("absence")) return fiche.taux_journalier;
  if (l.includes("supplémentaire") || l.includes("heure sup") || l.includes("heures sup"))
    return fiche.taux_horaire_sup;
  if (l.includes("férié") || l.includes("majoré")) return fiche.taux_journalier;

  return undefined;
}

export function buildFichePaiePDF(
  fiche: FichePaie,
  employee: EmployeeInfo,
  company: CompanyInfo = {}
): jsPDF {
  const { name = COMPANY.name, logoDataUrl } = company;

  const doc = new jsPDF("portrait", "mm", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 20;
  const marginRight = 20;
  const contentWidth = pageWidth - marginLeft - marginRight;

  // ---- Header: logo top-left, company identity next to it ----
  const logoSize = 24;
  const textX = logoDataUrl ? marginLeft + logoSize + 6 : marginLeft;

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, "PNG", marginLeft, 14, logoSize, logoSize);
  }

  doc.setTextColor(...BLACK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(name, textX, 21);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  doc.text(COMPANY.adresse, textX, 26.5, { maxWidth: contentWidth - (textX - marginLeft) });
  doc.text(`MF : ${COMPANY.mf}`, textX, 31);
  doc.text(`CNSS Employeur : ${COMPANY.cnssEmployeur}`, textX, 35.5);

  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.7);
  doc.line(marginLeft, 41, pageWidth - marginRight, 41);

  // ---- Document title ----
  doc.setTextColor(...BLACK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("BULLETIN DE PAIE", pageWidth / 2, 51, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...GOLD);
  doc.text(moisLabel(fiche.mois), pageWidth / 2, 57.5, { align: "center" });

  // ---- 1. Informations employé ----
  let y = 69;
  sectionTitle(doc, "Informations employé", marginLeft, y, contentWidth);
  y += 5;

  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join(" ") || "—";

  autoTable(doc, {
    startY: y,
    head: [["CIN", "Nom & Prénom", "N° CNSS", "Poste", "Département", "Catégorie", "Situation familiale", "Nb enfants"]],
    body: [[
      employee.cni || "—",
      nomComplet,
      employee.num_secu || "—",
      employee.poste || "—",
      employee.departement || "—",
      employee.categorie || "—",
      employee.situation_familiale || "—",
      employee.nombre_enfants !== undefined && employee.nombre_enfants !== null && employee.nombre_enfants !== ""
        ? String(employee.nombre_enfants)
        : "—",
    ]],
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7.5, fontStyle: "bold", halign: "center" },
    bodyStyles: { fontSize: 9, halign: "center", textColor: INK },
    alternateRowStyles: { fillColor: GOLD_FAINT },
    styles: { lineColor: GOLD_LIGHT, lineWidth: 0.15, cellPadding: 3 },
    margin: { left: marginLeft, right: marginRight },
  });

  y = (doc as any).lastAutoTable.finalY + 9;

  // ---- 2. Détails de contrat ----
  sectionTitle(doc, "Détails de contrat", marginLeft, y, contentWidth);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [[
      "Type de contrat", "Date d'embauche", "Mode de paiement",
      "Droit congé", "Solde restant", "Congés pris ce mois",
    ]],
    body: [[
      employee.type_contrat || "—",
      employee.date_embauche || "—",
      employee.mode_paiement || "—",
      `${fiche.droit_conge} j`,
      `${fiche.solde_conge} j`,
      `${fiche.jours_conge} j`,
    ]],
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7.5, fontStyle: "bold", halign: "center" },
    bodyStyles: { fontSize: 8.5, halign: "center", textColor: INK },
    styles: { lineColor: GOLD_LIGHT, lineWidth: 0.15, cellPadding: 2.5 },
    margin: { left: marginLeft, right: marginRight },
  });

  y = (doc as any).lastAutoTable.finalY + 9;

  // ---- 3. Présence ----
  sectionTitle(doc, "Présence", marginLeft, y, contentWidth);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [["Jours travaillés", "Absences", "Retards", "Heures sup. brutes", "Heures sup. payées"]],
    body: [[
      String(fiche.jours_travailles),
      String(fiche.jours_absence),
      formatMinutesEnHeures(fiche.retard_minutes),
      `${fiche.heures_supplementaires_brutes.toFixed(2)}h`,
      `${fiche.heures_supplementaires.toFixed(2)}h`,
    ]],
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7.5, fontStyle: "bold", halign: "center" },
    bodyStyles: { fontSize: 9.5, halign: "center", textColor: INK },
    styles: { lineColor: GOLD_LIGHT, lineWidth: 0.15, cellPadding: 2.5 },
    margin: { left: marginLeft, right: marginRight },
  });

  y = (doc as any).lastAutoTable.finalY + 9;

  // ---- 4. Détails paie ----
  sectionTitle(doc, "Détails paie", marginLeft, y, contentWidth);
  y += 3;

  const rows: string[][] = [];
  fiche.details.forEach((d) => {
    const isDeduction = d.type === "deduction" || d.montant < 0;
    const montant = Math.abs(d.montant);
    const isBase = /base/i.test(d.label); // Salaire de base → no Nombre, no Taux

    const nombre = isBase ? undefined : resolveNombre(d.label, fiche);
    const taux = !isBase ? resolveTaux(d.label, fiche) : undefined;

    rows.push([
      d.label,
      nombre !== undefined ? (nombre % 1 === 0 ? String(nombre) : nombre.toFixed(2)) : "",
      taux !== undefined ? NUM(taux) : "",
      isDeduction ? "" : DT(montant),
      isDeduction ? DT(montant) : "",
    ]);

    if (isBase) {
      const jours = fiche.jours_travailles;

      rows.push([
        "Nombre de jours présent",
        jours !== undefined ? String(jours) : "",
        "30.00",
        "",
        "",
      ]);
    }
  });

  autoTable(doc, {
    startY: y,
    head: [["Rubrique", "Nombre", "Taux", "Gain (DT)", "Retenue (DT)"]],
    body: rows,
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 8.5, fontStyle: "bold", halign: "center" },
    styles: { fontSize: 9.5, cellPadding: 2.8, lineColor: GOLD_LIGHT, lineWidth: 0.15, textColor: INK },
    columnStyles: {
      0: { cellWidth: contentWidth - 100 },
      1: { cellWidth: 20, halign: "center" },
      2: { cellWidth: 20, halign: "right" },
      3: { cellWidth: 30, halign: "right" },
      4: { cellWidth: 30, halign: "right" },
    },
    margin: { left: marginLeft, right: marginRight },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 4 && data.cell.text[0]) {
        data.cell.styles.textColor = [150, 40, 40];
      }
    },
  });

  y = (doc as any).lastAutoTable.finalY + 6;

  // ---- Net à payer banner ----
  const bannerH = 12;
  doc.setFillColor(...BLACK);
  doc.rect(marginLeft, y, contentWidth, bannerH, "F");
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.5);
  doc.rect(marginLeft, y, contentWidth, bannerH, "S");
  doc.setTextColor(...GOLD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("NET À PAYER", marginLeft + 5, y + bannerH / 2 + 1.4);
  doc.text(DT(fiche.net_a_payer), pageWidth - marginRight - 5, y + bannerH / 2 + 1.4, { align: "right" });
  doc.setTextColor(...BLACK);

  y += bannerH + 8;

  if (fiche.commentaire_admin) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.text(`Note : ${fiche.commentaire_admin}`, marginLeft, y, { maxWidth: contentWidth });
    y += 10;
  }

  // ---- Signatures — plain (not bold), capped so a blank area for the
  // stamp/signature always remains below, never crowding the page edge.
  const idealSigY = pageHeight - 55; // where it sits by default on a normal-length slip
  const maxSigY = pageHeight - 42;   // hard cap: content never pushes it past this
  const sigY = Math.min(Math.max(y + 12, idealSigY), maxSigY);
  const colWidth = contentWidth / 2;
  const leftCenterX = marginLeft + colWidth / 2;
  const rightCenterX = marginLeft + colWidth + colWidth / 2;
  const sigLineWidth = 55; // fixed width, centered under each label

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  doc.text("Signature et cachet de l'entreprise", leftCenterX, sigY, { align: "center" });
  doc.text("Signature employé", rightCenterX, sigY, { align: "center" });

  doc.setDrawColor(...GOLD_LIGHT);
  doc.setLineWidth(0.2);
  doc.line(leftCenterX - sigLineWidth / 2, sigY + 22, leftCenterX + sigLineWidth / 2, sigY + 22);
  doc.line(rightCenterX - sigLineWidth / 2, sigY + 22, rightCenterX + sigLineWidth / 2, sigY + 22);

  return doc;
}

export function downloadFichePaiePDF(fiche: FichePaie, employee: EmployeeInfo, company?: CompanyInfo) {
  const doc = buildFichePaiePDF(fiche, employee, company);
  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join("_") || "employe";
  doc.save(`fiche-paie_${nomComplet}_${fiche.mois.slice(0, 7)}.pdf`);
}