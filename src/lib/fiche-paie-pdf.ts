import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FichePaie, moisLabel } from "@/lib/fiche-paie";
import { formatMinutesEnHeures } from "@/lib/format";
import { AMIRI_BASE64 } from "@/lib/arabic-font";

interface EmployeeInfo {
  matricule?: string | null;
  nom?: string | null;
  prenom?: string | null;
  poste?: string | null;
  departement?: string | null;
  cni?: string | null;
  num_secu?: string | null; // N° CNSS
  date_embauche?: string | null; // ISO yyyy-mm-dd
  type_contrat?: string | null;
  mode_paiement?: string | null; // Virement, Chèque, Espèce
  date_paiement?: string | null; // ISO yyyy-mm-dd, defaults to last day of the month
  categorie?: string | null;
  echelon?: string | number | null;
  situation_familiale?: string | null;
  nombre_enfants?: number | string | null;
}

interface CompanyInfo {
  name?: string;
  logoDataUrl?: string;
}

// Hardcoded company identity — to be wired into CompanyInfo later.
const COMPANY = {
  name: "AERONOVA ENGINEERING",
  adresse: "N°47 Rue Fathi Zouhir Cité Nkhilette 2083 Raoued Ariana-Tunisie",
  mf: "1919265 L/A/M/000",
  cnssEmployeur: "696028 - 53",
};

// Brand palette — black & gold, no blue anywhere.
type RGB = [number, number, number];
const BLACK: RGB = [23, 23, 23];
const GOLD: RGB = [176, 137, 62];
const GOLD_LIGHT: RGB = [232, 219, 189];
const GRAY: RGB = [120, 120, 120];
const INK: RGB = [40, 40, 40];
const RED: RGB = [150, 40, 40];

// 1865.945 -> "1 865.945" (3 decimals = dinar millimes, space thousands separator)
function fmt(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(3).split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${dec}`;
}

// "2016-12-01" -> "01/12/2016"
function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function lastDayOfMonthISO(moisISODate: string): string {
  const [y, m] = moisISODate.split("-").map(Number);
  const d = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Nombre" column: the count the rubrique is computed on. */
function resolveNombre(label: string, fiche: FichePaie): number | undefined {
  const l = label.toLowerCase();
  if (/base/.test(l)) return fiche.jours_travailles;
  if (l.includes("absence")) return fiche.jours_absence;
  if (l.includes("supplémentaire") || l.includes("heure sup") || l.includes("heures sup"))
    return fiche.heures_supplementaires;
  if (l.includes("férié") || l.includes("majoré")) return fiche.jours_feries_travailles;
  return undefined;
}

/**
 * "Base" column: monthly salary for the base line, otherwise the unit rate
 * persisted on the fiche (computed once in SQL, never re-derived here).
 */
function resolveBase(label: string, fiche: FichePaie): number | undefined {
  const l = label.toLowerCase();
  if (/base/.test(l)) return fiche.salaire_base;
  if (l.includes("absence")) return fiche.taux_journalier;
  if (l.includes("supplémentaire") || l.includes("heure sup") || l.includes("heures sup"))
    return fiche.taux_horaire_sup;
  if (l.includes("férié") || l.includes("majoré")) return fiche.taux_journalier;
  return undefined;
}

// Arabic caption for the most common rubriques.
function arabicRubrique(label: string): string | undefined {
  const l = label.toLowerCase();
  if (/base/.test(l)) return "الراتب الشهري";
  if (l.includes("brut")) return "الأجر الخام";
  if (l.includes("absence")) return "الغياب";
  if (l.includes("supplémentaire") || l.includes("heure sup")) return "الساعات الإضافية";
  if (l.includes("férié")) return "الأعياد";
  if (l.includes("transport")) return "منحة النقل";
  if (l.includes("présence")) return "منحة الحضور";
  if (l.includes("prime")) return "المنحة";
  if (l.includes("retard")) return "التأخير";
  return undefined;
}

/**
 * Renders the payslip once at a given density `scale` (1 = comfortable,
 * lower = tighter rows). The public builder retries with a smaller scale
 * until everything fits on a single page.
 */
function render(
  fiche: FichePaie,
  employee: EmployeeInfo,
  company: CompanyInfo,
  scale: number
): jsPDF {
  const { name = COMPANY.name, logoDataUrl } = company;

  const doc = new jsPDF("portrait", "mm", "a4");
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 15;
  const marginRight = 15;
  const contentWidth = pageWidth - marginLeft - marginRight;
  const R = pageWidth - marginRight;

  // Arabic: embedded Amiri font (jsPDF shapes/reverses the text with lang: "ar").
  doc.addFileToVFS("Amiri-Regular.ttf", AMIRI_BASE64);
  doc.addFont("Amiri-Regular.ttf", "Amiri", "normal");

  /** Right-aligned Arabic text ending at x. */
  const ar = (text: string, x: number, y: number, size = 8, color: RGB = INK) => {
    doc.setFont("Amiri", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(text, x, y, { align: "right", lang: "ar" });
  };

  /** Section title: French on the left, Arabic on the right, gold rule below. */
  const sectionTitle = (fr: string, arText: string, y: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...BLACK);
    doc.text(fr.toUpperCase(), marginLeft, y);
    ar(arText, R, y, 11, GOLD);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.6);
    doc.line(marginLeft, y + 2, R, y + 2);
  };

  // ---------------------------------------------------------------- Header
  const logoSize = 22;
  const textX = logoDataUrl ? marginLeft + logoSize + 6 : marginLeft;

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, "PNG", marginLeft, 11, logoSize, logoSize);
  }

  doc.setTextColor(...BLACK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(name, textX, 17);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...GRAY);
  doc.text(COMPANY.adresse, textX, 22, { maxWidth: 100 });
  doc.text(`MF : ${COMPANY.mf}    |    CNSS Employeur : ${COMPANY.cnssEmployeur}`, textX, 30);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BLACK);
  doc.text("BULLETIN DE PAIE", R, 18, { align: "right" });
  ar("بطاقة خلاص", R, 25, 13, GOLD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...GOLD);
  doc.text(moisLabel(fiche.mois).toUpperCase(), R, 31, { align: "right" });

  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.7);
  doc.line(marginLeft, 37, R, 37);

  // ------------------------------------------------- 1. Informations employé
  let y = 46;
  sectionTitle("Informations employé", "معلومات العامل", y);
  y += 3;

  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join(" ").toUpperCase() || "—";
  const enfants =
    employee.nombre_enfants !== undefined && employee.nombre_enfants !== null && employee.nombre_enfants !== ""
      ? `${employee.nombre_enfants} enf.`
      : "";
  const situation = [employee.situation_familiale, enfants].filter(Boolean).join(" · ") || "—";

  const infoTable = (head: string[], body: string[], widths: number[], startY: number) =>
    autoTable(doc, {
      startY,
      head: [head],
      body: [body],
      theme: "grid",
      headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7.5, fontStyle: "bold", halign: "center", cellPadding: 2 },
      bodyStyles: { fontSize: 9, halign: "center", textColor: INK, cellPadding: 2.4 },
      styles: { lineColor: GOLD_LIGHT, lineWidth: 0.15 },
      columnStyles: Object.fromEntries(widths.map((w, k) => [k, { cellWidth: w }])),
      margin: { left: marginLeft, right: marginRight },
    });

  infoTable(
    ["Matricule", "Nom & Prénom", "C.I.N", "N° CNSS", "Date d'embauche", "Type de contrat"],
    [
      employee.matricule || "—",
      nomComplet,
      employee.cni || "—",
      employee.num_secu || "—",
      fmtDate(employee.date_embauche),
      employee.type_contrat || "—",
    ],
    [22, 52, 26, 28, 24, 28],
    y
  );

  infoTable(
    ["Qualification", "Département", "Catégorie", "Echelon", "Situation familiale", "Mode de paiement"],
    [
      (employee.poste || "—").toUpperCase(),
      employee.departement || "—",
      employee.categorie || "—",
      employee.echelon !== undefined && employee.echelon !== null && employee.echelon !== "" ? String(employee.echelon) : "—",
      situation,
      employee.mode_paiement || fiche.mode_paiement || "—",
    ],
    [44, 36, 24, 20, 30, 26],
    (doc as any).lastAutoTable.finalY + 4
  );

  y = (doc as any).lastAutoTable.finalY + 8;

  // ---------------------------------------------------- 2. Présence & congés
  sectionTitle("Présence & congés", "الحضور والعطل", y);
  y += 4;

  autoTable(doc, {
    startY: y,
    head: [[
      "Jours travaillés", "Absences", "Retards", "H. sup. brutes", "H. sup. payées",
      "Congés pris", "Solde congé",
    ]],
    body: [[
      String(fiche.jours_travailles),
      String(fiche.jours_absence),
      formatMinutesEnHeures(fiche.retard_minutes),
      `${fiche.heures_supplementaires_brutes.toFixed(2)}h`,
      `${fiche.heures_supplementaires.toFixed(2)}h`,
      `${fiche.jours_conge} j`,
      `${fiche.solde_conge} / ${fiche.droit_conge} j`,
    ]],
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7.5, fontStyle: "bold", halign: "center", cellPadding: 2 },
    bodyStyles: { fontSize: 9, halign: "center", textColor: INK, cellPadding: 2.2 },
    styles: { lineColor: GOLD_LIGHT, lineWidth: 0.15 },
    margin: { left: marginLeft, right: marginRight },
  });

  y = (doc as any).lastAutoTable.finalY + 8;

  // ---------------------------------------------------------- 3. Détails paie
  const gains = fiche.details.filter((d) => !(d.type === "deduction" || d.montant < 0));
  const deductions = fiche.details.filter((d) => d.type === "deduction" || d.montant < 0);
  const totalGains = gains.reduce((s, d) => s + d.montant, 0);

  type Meta = { arLabel?: string; bold?: boolean };
  const metas: Meta[] = [];
  const rows: string[][] = [];

  const pushRow = (
    label: string,
    base: number | undefined,
    nombre: number | undefined,
    gain: number | undefined,
    retenue: number | undefined,
    meta: Meta
  ) => {
    rows.push([
      label,
      base !== undefined ? fmt(base) : "",
      nombre !== undefined ? (nombre % 1 === 0 ? String(nombre) : nombre.toFixed(2)) : "",
      gain !== undefined ? fmt(gain) : "",
      retenue !== undefined ? fmt(retenue) : "",
    ]);
    metas.push(meta);
  };

  gains.forEach((d) =>
    pushRow(d.label, resolveBase(d.label, fiche), resolveNombre(d.label, fiche), d.montant, undefined, {
      arLabel: arabicRubrique(d.label),
    })
  );
  if (deductions.length > 0) {
    pushRow("Salaire brut", undefined, undefined, totalGains, undefined, {
      arLabel: arabicRubrique("brut"),
      bold: true,
    });
  }
  deductions.forEach((d) =>
    pushRow(d.label, resolveBase(d.label, fiche), resolveNombre(d.label, fiche), undefined, Math.abs(d.montant), {
      arLabel: arabicRubrique(d.label),
    })
  );

  // Optional admin note (measured now so the table can reserve room for it).
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8.5);
  const noteLines = fiche.commentaire_admin
    ? (doc.splitTextToSize(`Note : ${fiche.commentaire_admin}`, contentWidth) as string[])
    : [];

  // ---- Fixed bottom zone (anchored to the page bottom) ----
  const sigY = pageHeight - 44;
  const bannerH = 12;
  const reserve = bannerH + 5 + 6 + (noteLines.length ? noteLines.length * 4 + 3 : 0) + 4;

  // ---- One-page fit: pick font/padding from the space available per row ----
  sectionTitle("Détails paie", "تفاصيل الأجر", y);
  y += 4;

  const headH = 7;
  const avail = sigY - 4 - reserve - y - headH;
  const perRow = Math.min(9, (avail / Math.max(rows.length, 1)) * scale);
  const fs = perRow >= 8 ? 9.5 : perRow >= 6.8 ? 9 : perRow >= 5.8 ? 8 : perRow >= 5 ? 7.5 : 7;
  const pad = Math.max(0.4, Math.min(2.6, (perRow - fs * 0.406) / 2));

  autoTable(doc, {
    startY: y,
    head: [["Rubrique", "Base", "Nombre", "Gain (DT)", "Retenue (DT)"]],
    body: rows,
    theme: "grid",
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 8.5, fontStyle: "bold", halign: "center", cellPadding: 2 },
    styles: {
      fontSize: fs,
      cellPadding: { top: pad, bottom: pad, left: 2.5, right: 2.5 },
      textColor: INK,
      lineColor: GOLD_LIGHT,
      lineWidth: 0.15,
    },
    columnStyles: {
      0: { cellWidth: contentWidth - 112, halign: "left" },
      1: { cellWidth: 26, halign: "right" },
      2: { cellWidth: 20, halign: "center" },
      3: { cellWidth: 33, halign: "right" },
      4: { cellWidth: 33, halign: "right" },
    },
    margin: { left: marginLeft, right: marginRight },
    didParseCell: (data) => {
      if (data.section === "head") data.cell.styles.halign = "center";
      if (data.section !== "body") return;
      const meta = metas[data.row.index];
      if (meta?.bold) {
        data.cell.styles.fontStyle = "bold";
      }
      if (data.column.index === 4 && data.cell.text[0]) {
        data.cell.styles.textColor = RED;
      }
    },
    didDrawCell: (data) => {
      // Arabic caption on the right side of the "Rubrique" cell.
      if (data.section !== "body" || data.column.index !== 0) return;
      const meta = metas[data.row.index];
      if (!meta?.arLabel) return;
      ar(meta.arLabel, data.cell.x + data.cell.width - 2.5, data.cell.y + data.cell.height / 2 + 1.2, fs, GRAY);
    },
  });

  y = (doc as any).lastAutoTable.finalY + 5;

  // ------------------------------------------------------- Net à payer banner
  doc.setFillColor(...BLACK);
  doc.rect(marginLeft, y, contentWidth, bannerH, "F");
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.5);
  doc.rect(marginLeft, y, contentWidth, bannerH, "S");
  doc.setTextColor(...GOLD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("NET À PAYER", marginLeft + 5, y + bannerH / 2 + 1.4);
  ar("الصافي للدفع", marginLeft + 52, y + bannerH / 2 + 1.6, 11, GOLD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.setTextColor(...GOLD);
  doc.text(`${fmt(fiche.net_a_payer)} DT`, R - 5, y + bannerH / 2 + 1.4, { align: "right" });

  y += bannerH + 6;

  // ------------------------------------------------------------ Paiement line
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text("Mode de paiement :", marginLeft, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...BLACK);
  doc.text((employee.mode_paiement || fiche.mode_paiement || "—").toUpperCase(), marginLeft + 30, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text("Date de paiement :", marginLeft + 80, y);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...BLACK);
  doc.text(fmtDate(employee.date_paiement || lastDayOfMonthISO(fiche.mois)), marginLeft + 108, y);

  if (noteLines.length) {
    y += 5;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8.5);
    doc.setTextColor(...GRAY);
    doc.text(noteLines, marginLeft, y);
  }

  // ---------------------------------------------------- Signatures (anchored)
  const colWidth = contentWidth / 2;
  const leftCenterX = marginLeft + colWidth / 2;
  const rightCenterX = marginLeft + colWidth + colWidth / 2;
  const sigLineWidth = 60;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text("Signature et cachet de l'entreprise", leftCenterX, sigY, { align: "center" });
  doc.text("Signature employé (émargement)", rightCenterX, sigY, { align: "center" });

  doc.setFont("Amiri", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  doc.text("إمضاء وختم المؤسسة", leftCenterX, sigY + 5, { align: "center", lang: "ar" });
  doc.text("إمضاء العامل", rightCenterX, sigY + 5, { align: "center", lang: "ar" });

  doc.setDrawColor(...GOLD_LIGHT);
  doc.setLineWidth(0.2);
  doc.line(leftCenterX - sigLineWidth / 2, sigY + 24, leftCenterX + sigLineWidth / 2, sigY + 24);
  doc.line(rightCenterX - sigLineWidth / 2, sigY + 24, rightCenterX + sigLineWidth / 2, sigY + 24);

  // ------------------------------------------------------------------ Footer
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.4);
  doc.line(marginLeft, pageHeight - 13, R, pageHeight - 13);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...GRAY);
  doc.text(`${name}  ·  MF ${COMPANY.mf}`, marginLeft, pageHeight - 8.5);
  doc.text("Ce bulletin de paie doit être conservé sans limitation de durée.", R, pageHeight - 8.5, {
    align: "right",
  });

  return doc;
}

export function buildFichePaiePDF(
  fiche: FichePaie,
  employee: EmployeeInfo,
  company: CompanyInfo = {}
): jsPDF {
  // A payslip is always a single page: tighten the density step by step
  // until the content fits.
  const scales = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
  let doc = render(fiche, employee, company, scales[0]);

  for (let i = 1; i < scales.length && doc.getNumberOfPages() > 1; i++) {
    doc = render(fiche, employee, company, scales[i]);
  }

  // Last-resort guarantee: never ship more than one page.
  while (doc.getNumberOfPages() > 1) {
    doc.deletePage(doc.getNumberOfPages());
  }

  return doc;
}

export function downloadFichePaiePDF(fiche: FichePaie, employee: EmployeeInfo, company?: CompanyInfo) {
  const doc = buildFichePaiePDF(fiche, employee, company);
  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join("_") || "employe";
  doc.save(`fiche-paie_${nomComplet}_${fiche.mois.slice(0, 7)}.pdf`);
}