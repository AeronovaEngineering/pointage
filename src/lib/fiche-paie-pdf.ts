import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FichePaie, moisLabel } from "@/lib/fiche-paie";
import { formatDateFR, formatMinutesEnHeures } from "@/lib/format";

interface EmployeeInfo {
  nom?: string | null;
  prenom?: string | null;
  poste?: string | null;
  departement?: string | null;
  cni?: string | null;
  num_secu?: string | null;
  date_embauche?: string | null;
}

const DT = (n: number) => `${n.toFixed(2)} DT`;

// Brand palette — black & gold, no blue anywhere.
const BLACK: [number, number, number] = [23, 23, 23];
const GOLD: [number, number, number] = [176, 137, 62];
const GOLD_LIGHT: [number, number, number] = [242, 233, 214];
const GRAY: [number, number, number] = [120, 120, 120];
const WHITE: [number, number, number] = [255, 255, 255];

const COMPANY_NAME = "AERONOVA ENGINEERING";
const COMPANY_SUBTITLE = "Ressources Humaines & Administration";
const LOGO_URL = "/logo.png";

function loadLogo(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function sectionTitle(doc: jsPDF, label: string, x: number, y: number, width: number) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...BLACK);
  doc.text(label.toUpperCase(), x, y);
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.6);
  doc.line(x, y + 1.6, x + width, y + 1.6);
}

function field(doc: jsPDF, label: string, value: string, x: number, y: number) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...BLACK);
  const labelText = `${label} : `;
  doc.text(labelText, x, y);
  const labelWidth = doc.getTextWidth(labelText);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(40, 40, 40);
  doc.text(value || "—", x + labelWidth, y);
}

export async function buildFichePaiePDF(
  fiche: FichePaie,
  employee: EmployeeInfo,
  companyName: string = COMPANY_NAME
): Promise<jsPDF> {
  // A5 — a full payslip's content is short enough that A4 leaves the sheet
  // half empty; A5 prints as a compact, professional half-page document.
  const doc = new jsPDF("portrait", "mm", "a5");
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 10;
  const marginRight = 10;
  const contentWidth = pageWidth - marginLeft - marginRight;

  // ---- Header: company identity (left) + logo (top right) ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...BLACK);
  doc.text(companyName, marginLeft, 13);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(...GRAY);
  doc.text(COMPANY_SUBTITLE, marginLeft, 17.5);

  const logo = await loadLogo(LOGO_URL);
  if (logo && logo.width && logo.height) {
    const maxW = 20;
    const maxH = 14;
    const ratio = Math.min(maxW / logo.width, maxH / logo.height);
    const w = logo.width * ratio;
    const h = logo.height * ratio;
    doc.addImage(logo, "PNG", pageWidth - marginRight - w, 6, w, h);
  }

  // ---- Title ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BLACK);
  doc.text("BULLETIN DE PAIE", pageWidth / 2, 27, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  const statutLabel = fiche.statut === "validee" ? "Validée" : "Brouillon";
  const dateLabel = fiche.valide_at ? `Validée le ${formatDateFR(fiche.valide_at)}` : statutLabel;
  doc.text(`Période : ${moisLabel(fiche.mois)}  —  ${dateLabel}`, pageWidth / 2, 32.5, { align: "center" });

  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.8);
  doc.line(marginLeft, 36, pageWidth - marginRight, 36);

  // ---- Section 1: Informations générales ----
  let y = 43;
  sectionTitle(doc, "1. Informations générales", marginLeft, y, contentWidth);
  y += 6;

  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join(" ") || "—";
  const colGap = contentWidth / 2;
  field(doc, "Nom et prénom", nomComplet, marginLeft, y);
  field(doc, "N° CIN", employee.cni || "—", marginLeft + colGap, y);
  y += 5.5;
  field(doc, "Poste", employee.poste || "—", marginLeft, y);
  field(doc, "Date d'embauche", employee.date_embauche ? formatDateFR(employee.date_embauche) : "—", marginLeft + colGap, y);
  y += 8;

  // ---- Section 2: Période & présence ----
  sectionTitle(doc, "2. Période & présence", marginLeft, y, contentWidth);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [["Jours travaillés", "Absences", "Congés", "Retards cumulés", "Heures sup."]],
    body: [[
      String(fiche.jours_travailles),
      String(fiche.jours_absence),
      String(fiche.jours_conge),
      formatMinutesEnHeures(fiche.retard_minutes),
      `${fiche.heures_supplementaires.toFixed(1)}h`,
    ]],
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 7, fontStyle: "bold", halign: "center" },
    bodyStyles: { fontSize: 8, halign: "center", textColor: [30, 30, 30] },
    margin: { left: marginLeft, right: marginRight },
    tableLineColor: GOLD_LIGHT,
    tableLineWidth: 0.1,
  });

  y = (doc as any).lastAutoTable.finalY + 6;

  // ---- Section 3: Détail de la rémunération ----
  sectionTitle(doc, "3. Détail de la rémunération", marginLeft, y, contentWidth);
  y += 3;

  const rows = fiche.details.map((d) => [d.label, d.type === "deduction" ? "Déduction" : "Gain", DT(d.montant)]);

  autoTable(doc, {
    startY: y,
    head: [["Élément", "Type", "Montant"]],
    body: rows,
    headStyles: { fillColor: BLACK, textColor: GOLD, fontSize: 8, fontStyle: "bold" },
    styles: { fontSize: 8, cellPadding: 1.8, textColor: [30, 30, 30] },
    columnStyles: {
      0: { cellWidth: contentWidth - 55 },
      1: { cellWidth: 28 },
      2: { cellWidth: 27, halign: "right" },
    },
    margin: { left: marginLeft, right: marginRight },
    tableLineColor: GOLD_LIGHT,
    tableLineWidth: 0.1,
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 2) {
        const raw = fiche.details[data.row.index]?.montant ?? 0;
        if (raw < 0) data.cell.styles.textColor = [150, 40, 40];
      }
    },
  });

  y = (doc as any).lastAutoTable.finalY + 4;

  // ---- Net à payer banner ----
  const bannerH = 10;
  doc.setFillColor(...BLACK);
  doc.rect(marginLeft, y, contentWidth, bannerH, "F");
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.5);
  doc.rect(marginLeft, y, contentWidth, bannerH, "S");
  doc.setTextColor(...GOLD);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("NET À PAYER", marginLeft + 4, y + bannerH / 2 + 1.2);
  doc.text(DT(fiche.net_a_payer), pageWidth - marginRight - 4, y + bannerH / 2 + 1.2, { align: "right" });
  doc.setTextColor(0, 0, 0);

  y += bannerH + 5;

  if (fiche.commentaire_admin) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(...GRAY);
    doc.text(`Note : ${fiche.commentaire_admin}`, marginLeft, y, { maxWidth: contentWidth });
    y += 8;
  }

  // ---- Signatures ----
  const sigY = Math.max(y + 6, pageHeight - 28);
  const sigBoxW = (contentWidth - 10) / 2;

  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.3);
  doc.line(marginLeft, sigY, marginLeft + sigBoxW, sigY);
  doc.line(marginLeft + sigBoxW + 10, sigY, marginLeft + sigBoxW + 10 + sigBoxW, sigY);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...BLACK);
  doc.text("Signature — Responsable RH", marginLeft, sigY + 4);
  doc.text("Signature — Gérant", marginLeft + sigBoxW + 10, sigY + 4);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.5);
  doc.setTextColor(...GRAY);
  doc.text("(si document imprimé)", marginLeft, sigY + 7.5);
  doc.text("(si document imprimé)", marginLeft + sigBoxW + 10, sigY + 7.5);

  // ---- Footer ----
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.3);
  doc.line(marginLeft, pageHeight - 12, pageWidth - marginRight, pageHeight - 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.3);
  doc.setTextColor(...GRAY);
  doc.text(
    "Document généré automatiquement — à conserver pour vos démarches administratives.",
    pageWidth / 2,
    pageHeight - 8,
    { align: "center" }
  );

  return doc;
}

export async function downloadFichePaiePDF(fiche: FichePaie, employee: EmployeeInfo, companyName?: string) {
  const doc = await buildFichePaiePDF(fiche, employee, companyName);
  const nomComplet = [employee.prenom, employee.nom].filter(Boolean).join("_") || "employe";
  doc.save(`fiche-paie_${nomComplet}_${fiche.mois.slice(0, 7)}.pdf`);
}