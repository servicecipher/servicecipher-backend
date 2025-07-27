// Always log version for debugging live deploys!
console.log('🔥🔥🔥 SERVICECIPHER DEPLOYED CODE VERSION: ', Date.now());

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');

require('dotenv').config();
const { Clerk } = require('@clerk/clerk-sdk-node');
const clerk = Clerk({ apiKey: process.env.CLERK_SECRET_KEY });

const app = express();
const port = 3001;

// --- Only ONE CORS middleware, right after express() ---
app.use(cors({
  origin: [
    'https://servicecipher.com',
    'https://www.servicecipher.com',
    'https://servicecipher-frontend.vercel.app',
    'https://app.servicecipher.com'
  ],
  credentials: true,
}));

app.use(express.json());
const upload = multer({ dest: 'uploads/' });

const sectionOrder = [
  'DATE',
  'SHOP_NAME',
  'REASON_FOR_VISIT',
  'REPAIR_SUMMARY',
  'MAJOR',
  'MODERATE',
  'MINOR',
  'COST_BREAKDOWN',
  'WHAT_DOES_THIS_ACTUALLY_MEAN?',
  'OTHER_NOTES',
  'RECOMMENDATIONS'
];

function prettySectionLabel(section) {
  if (section === 'WHAT_DOES_THIS_ACTUALLY_MEAN?') return 'What Does This Actually Mean?';
  return section.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, l => l.toUpperCase());
}

// Cleans ALL markdown formatting (**, *, __, etc.)
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`(.*?)`/g, '$1');
}

// --- FUTURE PROOF SECTION FETCH ---
function getSection(sections, key, fallback = "Not provided") {
  if (
    sections[key] &&
    Array.isArray(sections[key]) &&
    sections[key][0] &&
    sections[key][0].toLowerCase() !== "none"
  ) {
    return cleanText(sections[key][0]);
  }
  return fallback;
}

function extractSections(text) {
  const sectionOrder = [
    'DATE',
    'SHOP_NAME',
    'REASON_FOR_VISIT',
    'REPAIR_SUMMARY',
    'MAJOR',
    'MODERATE',
    'MINOR',
    'COST_BREAKDOWN',
    'WHAT_DOES_THIS_ACTUALLY_MEAN?',
    'OTHER_NOTES',
    'RECOMMENDATIONS'
  ];

  const result = {};
  let current = null;

  const lines = text.split('\n').map(line =>
    line
      .trim()
      .replace(/\u2018|\u2019|\u201C|\u201D/g, "'") // smart quotes
      .replace(/^[-•*]+\s*/, '') // bullets/dashes/markdown
      .replace(/\*\*(.*?)\*\*/g, '$1') // remove bold
      .replace(/__(.*?)__/g, '$1') // remove underline
  );

  for (const line of lines) {
    const match = line.match(/^([A-Z _?']+)\s*:?$/i);
    if (match) {
      const sectionKey = match[1].trim().toUpperCase().replace(/\s+/g, '_');
      if (sectionOrder.includes(sectionKey)) {
        current = sectionKey;
        result[current] = [];
        continue;
      }
    }

    if (current && line.length > 0) {
      result[current].push(line);
    }
  }

  // Ensure every section is included
  sectionOrder.forEach(key => {
    if (!result[key] || result[key].length === 0) {
      result[key] = ['Not listed on the invoice'];
    }
  });

  return result;
}


function buildSectionCard(label, content, styleClass = "") {
  if (!content || content.length === 0 || (content.length === 1 && content[0].toLowerCase() === 'none')) return '';
  let html = `<div class="section-card ${styleClass}">`;
  html += `<div class="section-heading ${styleClass}">${label}</div>`;
  html += `<div class="section-content">`;
  if (content.some(line => line.trim().startsWith('-') || line.trim().startsWith('•'))) {
    html += "<ul>";
    content.forEach(line => {
      html += `<li>${cleanText(line.replace(/^[-•]\s*/, ""))}</li>`;
    });
    html += "</ul>";
  } else if (label === "Cost Breakdown") {
    // Table/grid for cost breakdown
    html += '<div class="cost-table">';
    content.forEach(line => {
      // Try to split at the last ":" (for cases like "1. Something: $99.99")
      const idx = line.lastIndexOf(':');
      if (idx !== -1) {
        const item = cleanText(line.slice(0, idx+1));
        const price = cleanText(line.slice(idx+1)).trim();
        html += `<div class="cost-row"><div class="cost-item">${item}</div><div class="cost-price">${price}</div></div>`;
      } else {
        html += `<div class="cost-row"><div class="cost-item" style="grid-column: 1 / span 2;">${cleanText(line)}</div></div>`;
      }
    });
    html += '</div>';
  } else {
    html += content.map(line => {
      const match = line.match(/^(.+?):\s*(.*)$/);
      if (match) {
        if (!match[2]) {
          return `<div class="card-line"><span class="card-title">${cleanText(match[1])}:</span></div>`;
        }
return `<div class="card-line"><span class="card-title">${cleanText(match[1])}:</span> ${cleanText(match[2])}</div>`;      }
      return `<div class="card-line">${cleanText(line)}</div>`;
    }).join('');
  }
  html += `</div></div>`;
  return html;
}

// --- BLUE CARD HELPER ---
function buildBlueCard(label, content) {
  // Accepts a string or array for content
  if (!content || (Array.isArray(content) && (!content[0] || content[0].toLowerCase() === "none")) || content === "Not provided") return '';
  const safeContent = Array.isArray(content) ? content.map(line => cleanText(line)).join("<br/>") : cleanText(content);
  return `
    <div class="section-card blue-card">
      <div class="section-heading blue">${label}</div>
      <div class="section-content">${safeContent}</div>
    </div>
  `;
}

app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  // console.log('ALLOWED EMAILS:', allowedEmails);
  console.log('RECEIVED HEADER x-user-email:', req.headers['x-user-email']);
  try {
    // Clerk user check
    const userEmail = req.headers['x-user-email'];
    const allUsers = await clerk.users.getUserList();
    const currentUser = allUsers.find(u => u.emailAddresses?.some(e => e.emailAddress === userEmail));

    if (!currentUser) {
      return res.status(403).json({ success: false, message: 'User not found.' });
    }

    const allowedIndustry = currentUser.publicMetadata?.industry || "auto";

    const fileBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(fileBuffer);
    const invoiceText = data.text;
    const userLanguage = req.headers['x-user-language'] || 'english';

    // --- PROMPT (unchanged) ---
    const prompt = `
Please write the following customer report in ${userLanguage}. The final output **MUST** be in the ${userLanguage}.
You have multiple roles. Your roles are as follows:

1. Professional, Friendly Auto Service/Repair Advisor
2. Professional, Friendly Auto Detailing Service Advisor
3. Professional, Friendly Medical Billing Assistant
4. Professional, Friendly Plumbing Service Advisor

------

## If the invoice is for Auto Repair, follow these instructions:

You are a professional, friendly auto service advisor. Your job is to help customers understand their auto repair invoice in plain, non-technical English — as if explaining it to someone who knows nothing about cars or auto repairs. Your writing must always be specific, helpful, and consistent — even if the invoice is short or vague.

Given the invoice below, generate a full, customer-facing report using these exact sections, in this exact order:

DATE  
SHOP_NAME  
REASON_FOR_VISIT  
REPAIR_SUMMARY  
MAJOR  
MODERATE  
MINOR  
COST_BREAKDOWN  
WHAT_DOES_THIS_ACTUALLY_MEAN?  
OTHER_NOTES  
RECOMMENDATIONS

---

### INSTRUCTIONS FOR EACH SECTION:

- **DATE:** State the date of service from the invoice. If not listed, use today’s date.

- **SHOP_NAME:** Extract the shop’s name. Leave blank if it truly does not appear.

- **REASON_FOR_VISIT:** Always include 2–3 sentences explaining why the customer likely brought the vehicle in.  
  - If stated, summarize clearly.  
  - If missing, infer it based on the repairs or services.  
  - Never leave this blank or write “None.”

- **REPAIR_SUMMARY:** In 3–5 sentences, summarize all repairs or services completed.  
  - Be clear, direct, and plain-spoken.  
  - Spell out what was done in customer-friendly language.  
  - If the invoice is vague, infer details based on standard procedures.  
  - Never skip this section.

- **MAJOR / MODERATE / MINOR REPAIRS:**  
  Categorize repairs with strict consistency. This is not stylistic — it is technical.

  - **MAJOR** repairs involve brakes, suspension, steering, internal engine, transmission, electrical faults, overheating, or safety systems (airbags, ABS).  
    These are repairs that — if ignored — could lead to breakdown, loss of control, or major damage.  
  - **MODERATE** repairs involve alignment, drivability, emissions, battery, A/C, warning lights, or non-critical but functional issues.  
  - **MINOR** repairs include fluid services, oil changes, wiper blades, filters, tire rotations, or any cosmetic or preventative work.  
  - When unsure, default to the **higher severity**.  
  - For each section, list 2–4 bullet points in this format:  
  - [Part or Service]: [Plain English explanation of why it mattered and what could happen if left undone]  
  - Example: Brake Pads: These create friction to stop your car. Worn-out pads increase stopping distance and can lead to brake failure.  
- Every bullet point must start with the part or service name followed by a colon.  
- Never write paragraphs inside this section — only clean bullet points as shown.
  - If there are no items in a section, write “None.”

- **COST_BREAKDOWN:**  
  List every part, labor, fee, tax, and total as a bullet list. Include numbers if possible. Always end with the total cost.

- **WHAT_DOES_THIS ACTUALLY MEAN?:**  
  For every major and moderate part or service listed in the invoice (e.g., control arms, ball joints, alignment, brakes, ignition coils, battery), explain:  
    - What it is  
    - Why it matters  
    - What can happen if it fails  
  Do not summarize the invoice here. This section is purely educational. Assume the reader has very little to no knowledge of cars. Use this format:

  - **Ball Joints:** Ball joints act as pivots between the wheels and the suspension. They help the car turn and move smoothly over bumps. If a ball joint fails, it can cause steering problems or make the wheel detach.

- **OTHER_NOTES:**  
  Add any warranties, reminders, or general notes from the invoice. If none are present, write: “No additional notes.”

- **RECOMMENDATIONS:**  
  If the invoice lists any recommendations (future services, maintenance reminders, or inspection suggestions), display those clearly in this section.  
  - Use the actual recommendations from the invoice as the main content.  
  - If there are no recommendations listed, provide 2–4 helpful, specific, non-salesy maintenance tips based on the repairs or inspection findings.  
  - Always write this section; never leave it blank or write "None."

---

## If the invoice is for Auto Detailing, follow these instructions:
You are a professional, friendly auto detailing service advisor. Your job is to help customers understand their detailing service invoice in plain, non-technical English — as if explaining it to someone who knows nothing about car detailing. Your writing must always be specific, helpful, and consistent — even if the invoice is short or vague.

Given the invoice below, generate a full, customer-facing report using these exact sections, in this exact order:

DATE
SHOP_NAME
REASON_FOR_VISIT
REPAIR_SUMMARY
MAJOR
MODERATE
MINOR
COST_BREAKDOWN
WHAT_DOES_THIS_ACTUALLY_MEAN?
OTHER_NOTES
RECOMMENDATIONS

⸻

INSTRUCTIONS FOR EACH SECTION:
	•	DATE: State the date of service from the invoice. If not listed, use today’s date.
	•	SHOP_NAME: Extract the detailing shop’s name. Leave blank if it truly does not appear.
	•	REASON_FOR_VISIT: Always include 2–3 sentences explaining why the customer likely brought the vehicle in.
	•	If stated, summarize clearly.
	•	If missing, infer it based on the services performed.
	•	Never leave this blank or write “None.”
	•	REPAIR_SUMMARY: In 3–5 sentences, summarize all detailing services completed.
	•	Be clear, direct, and plain-spoken.
	•	Spell out what was done in customer-friendly language.
	•	If the invoice is vague, infer details based on standard procedures.
	•	Never skip this section.
	•	MAJOR / MODERATE / MINOR REPAIRS:
Categorize detailing services with strict consistency. This is not stylistic — it is technical.
	•	MAJOR services involve deep interior cleaning (e.g., shampooing, odor removal, stain extraction), paint correction, ceramic coatings, engine bay detailing, or full-service premium packages.
These services significantly improve vehicle condition, resale value, or long-term protection.
	•	MODERATE services include waxing, clay bar treatments, headlight restoration, fabric protection, or full interior/exterior detailing without premium upgrades.
	•	MINOR services include hand washes, vacuuming, window cleaning, tire dressing, or any light cosmetic refresh.
	•	When unsure, default to the higher severity.
	•	For each section, list 2–4 bullet points in this format:
	•	[Service]: [Plain English explanation of what it is, why it was done, and the benefit to the customer]
	•	Example: Paint Correction: This service removed swirl marks and scratches from your paint, restoring shine and clarity.
	•	Every bullet point must start with the service name followed by a colon.
	•	Never write paragraphs inside this section — only clean bullet points as shown.
	•	If there are no items in a section, write “None.”
	•	COST_BREAKDOWN:
List every service, labor, fee, tax, and total as a bullet list. Include numbers if possible. Always end with the total cost.
	•	WHAT_DOES_THIS ACTUALLY MEAN?:
For every major and moderate service listed in the invoice (e.g., ceramic coating, paint correction, interior shampooing, clay bar treatment), explain:
	•	What it is
	•	Why it matters
	•	What can happen if it’s never done
Do not summarize the invoice here. This section is purely educational. Assume the reader has very little to no knowledge of detailing. Use this format:
	•	Ceramic Coating: A liquid polymer applied to your vehicle’s paint that hardens into a protective layer. It protects against UV rays, dirt, and chemicals, making the car easier to clean and preserving its shine.
	•	OTHER_NOTES:
Add any warranties, service reminders, or general notes from the invoice. If none are present, write: “No additional notes.”
	•	RECOMMENDATIONS:
If the invoice lists any recommendations (e.g., suggested follow-up services or maintenance intervals), display those clearly in this section.
	•	Use the actual recommendations from the invoice as the main content.
	•	If there are no recommendations listed, provide 2–4 helpful, specific, non-salesy suggestions to maintain the vehicle’s cleanliness and condition.
	•	Always write this section; never leave it blank or write “None.”

------

## If the invoice is for Medical Services, follow these instructions:
You are a professional, friendly medical billing assistant. Your job is to help patients understand their medical invoice in plain, non-technical English — as if explaining it to someone with no background in healthcare or billing. Your writing must always be specific, kind, and consistent — even if the invoice is brief or complex.

Given the invoice below, generate a full, patient-facing report using these exact sections, in this exact order:

DATE
SHOP_NAME
REASON_FOR_VISIT
REPAIR_SUMMARY
MAJOR
MODERATE
MINOR
COST_BREAKDOWN
WHAT_DOES_THIS_ACTUALLY_MEAN?
OTHER_NOTES
RECOMMENDATIONS

⸻

INSTRUCTIONS FOR EACH SECTION:
	•	DATE: State the date of service from the invoice. If not listed, use today’s date.
	•	SHOP_NAME: Extract the clinic or provider name. Leave blank if it truly does not appear.
	•	REASON_FOR_VISIT: Always include 2–3 sentences explaining why the patient likely came in.
	•	If stated, summarize clearly.
	•	If missing, infer it based on the procedures or billing codes.
	•	Never leave this blank or write “None.”
	•	REPAIR_SUMMARY: In 3–5 sentences, summarize all medical services provided.
	•	Use plain, patient-friendly language.
	•	Describe the general purpose of each procedure or evaluation.
	•	If the invoice is technical or vague, explain using common terms.
	•	Never skip this section.
	•	MAJOR / MODERATE / MINOR REPAIRS:
Categorize medical services with strict consistency. This is not stylistic — it is technical.
	•	MAJOR services involve surgeries, emergency care, diagnostic imaging (MRI/CT), anesthesia, or treatment of serious illness or injury.
These are critical for diagnosis or stabilization and often require follow-up care.
	•	MODERATE services include office visits, lab work, X-rays, minor procedures, injections, or specialist consultations.
	•	MINOR services include vitals checks, routine screenings, administrative charges, vaccinations, or health education.
	•	When unsure, default to the higher severity.
	•	For each section, list 2–4 bullet points in this format:
	•	[Procedure or Service]: [Plain English explanation of what it was, why it was done, and why it mattered]
	•	Example: CT Scan of Chest: A scan used to get a detailed image of your lungs and heart to help identify any issues.
	•	Every bullet point must start with the procedure name followed by a colon.
	•	Never write paragraphs inside this section — only clean bullet points as shown.
	•	If there are no items in a section, write “None.”
	•	COST_BREAKDOWN:
List every procedure, consultation, lab test, medication, tax, and total as a bullet list. Include amounts if possible. Always end with the total cost.
	•	WHAT_DOES_THIS ACTUALLY MEAN?:
For every major and moderate procedure listed in the invoice (e.g., CT scan, biopsy, injections, lab tests), explain:
	•	What it is
	•	Why it’s important
	•	What might happen if it was not done
Do not summarize the invoice here. This section is purely educational. Assume the reader has no medical background. Use this format:
	•	Blood Panel: A set of blood tests that check for a variety of conditions such as anemia, infections, or vitamin deficiencies. It helps doctors understand your overall health and detect problems early.
	•	OTHER_NOTES:
Add any insurance notes, patient instructions, or general billing comments. If none are present, write: “No additional notes.”
	•	RECOMMENDATIONS:
If the invoice includes follow-up instructions, medication reminders, or lifestyle suggestions, display those clearly in this section.
	•	Use the actual recommendations from the invoice as the main content.
	•	If there are no recommendations listed, offer 2–4 general health tips based on the visit context (e.g., hydration, follow-up scheduling, preventive screenings).
	•	Always write this section; never leave it blank or write “None.”

------
## If the invoice is for Plumbing Services, follow these instructions:
You are a professional, friendly plumbing service advisor. Your job is to help customers understand their plumbing invoice in plain, non-technical English — as if explaining it to someone with no background in plumbing or home maintenance. Your writing must always be specific, helpful, and consistent — even if the invoice is brief or technical.

Given the invoice below, generate a full, customer-facing report using these exact sections, in this exact order:

DATE
SHOP_NAME
REASON_FOR_VISIT
REPAIR_SUMMARY
MAJOR
MODERATE
MINOR
COST_BREAKDOWN
WHAT_DOES_THIS_ACTUALLY_MEAN?
OTHER_NOTES
RECOMMENDATIONS

⸻

INSTRUCTIONS FOR EACH SECTION:
	•	DATE: State the date of service from the invoice. If not listed, use today’s date.
	•	SHOP_NAME: Extract the plumbing company’s name. Leave blank if it truly does not appear.
	•	REASON_FOR_VISIT: Always include 2–3 sentences explaining why the customer likely requested service.
	•	If stated, summarize clearly.
	•	If missing, infer it based on the plumbing issues or services performed.
	•	Never leave this blank or write “None.”
	•	REPAIR_SUMMARY: In 3–5 sentences, summarize all plumbing services performed.
	•	Use plain, friendly language.
	•	Explain what was done and why.
	•	If the invoice is vague or highly technical, infer likely services.
	•	Never skip this section.
	•	MAJOR / MODERATE / MINOR REPAIRS:
Categorize plumbing work using strict consistency.
	•	MAJOR repairs involve pipe replacements, sewer line issues, major leaks, water heater installation/repair, or any repair that could cause flooding, structural damage, or health risk.
	•	MODERATE repairs include drain cleaning, fixture replacements (toilet, faucet), garbage disposal installation, water pressure issues, or minor leak repairs.
	•	MINOR repairs include inspections, minor adjustments, filter changes, caulking, or preventative maintenance.
	•	When unsure, default to the higher severity.
	•	For each section, list 2–4 bullet points in this format:
[Part or Service]: [Plain explanation of what it is, why it was done, and what could happen if left undone]
	•	Example:
Water Heater Replacement: The old unit was no longer functioning. A new one was installed to ensure consistent hot water and avoid potential flooding.
	•	Never write paragraphs — only clean bullet points.
	•	If there are no items in a section, write “None.”
	•	COST_BREAKDOWN:
List all services, parts, labor, fees, and total as a bullet list. Include numbers if available. Always end with the total cost.
	•	WHAT_DOES_THIS ACTUALLY MEAN?:
For every major and moderate service in the invoice, explain:
	•	What it is
	•	Why it matters
	•	What could happen if not fixed
Use this format:
Main Sewer Line Repair: The main pipe that carries waste from the house to the sewer. If damaged, it can cause sewage backups and major home damage.
	•	This section is educational, not a summary.
	•	OTHER_NOTES:
Add any warranties, follow-up appointments, or general notes from the invoice. If none are present, write: “No additional notes.”
	•	RECOMMENDATIONS:
If the invoice lists recommendations (e.g., future services, inspections, product replacements), include them here.
	•	If none are listed, provide 2–4 helpful and specific maintenance tips (e.g., “Consider insulating exposed pipes to prevent winter damage.”)
	•	Always write this section; never leave it blank or write “None.”

-----

### FORMAT RULES (CRITICAL):
- You must include every section above in the correct order, with each section header written **exactly** as shown.
- Each header must be followed by a colon and the content on the next line(s).
- Never skip or rename sections. If content is missing, provide a helpful fallback (e.g., “Not listed on the invoice”).
- Never write in paragraph form. Use clear headers, bullet lists, and short sections.
- Do not include markdown, HTML, code, or JSON.
- **For MAJOR, MODERATE, and MINOR sections, YOU MUST ONLY WRITE CLEAN BULLET POINTS with bolded part names followed by a colon. NEVER write paragraphs or long sentences in these sections.**
- Final output MUST be in ${userLanguage}.
---


INVOICE TO ANALYZE:  
--------------------  
${invoiceText}  
--------------------
 
At the end of your response, write:  
INVOICE_TYPE: [auto | detailing | medical | plumbing] based on the invoice contents.
`;

    // OpenAI call
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1400,
      temperature: 0.3
    });
    const summary = completion.choices[0].message.content;
    console.log("🧾 GPT Summary Output:\n", summary);

    // Determine invoiceType from summary (via INVOICE_TYPE: label if present)
    const { getAuth } = require('@clerk/clerk-sdk-node');

    // Use the existing correct user lookup logic
    // (already defined above, so do not redeclare userEmail/currentUser)

    let userIndustries = [];

    if (Array.isArray(currentUser.publicMetadata?.industries)) {
      userIndustries = currentUser.publicMetadata.industries.map(i => i.toLowerCase());
    } else if (typeof currentUser.publicMetadata?.industries === "string") {
      userIndustries = [currentUser.publicMetadata.industries.toLowerCase()];
    }

    const invoiceTypeMatch = summary.match(/INVOICE_TYPE:\s*(\w+)/i);
    const invoiceType = invoiceTypeMatch ? invoiceTypeMatch[1].toLowerCase() : undefined;
    const cleanedSummary = summary.replace(/^INVOICE_TYPE:.*$/m, '').trim();
    const sections = extractSections(cleanedSummary);

    console.log("👤 User Industries:", userIndustries);
    console.log("📄 Invoice Type Detected:", invoiceType);
    if (!userIndustries.includes(invoiceType)) {
      return res.status(403).json({
        success: false,
        message: `You do not have access to generate this type of report.`
      });
    }

    let majorLabel = 'Major Repairs';
    let moderateLabel = 'Moderate Repairs';
    let minorLabel = 'Minor Repairs';

    if (invoiceType.includes('detailing')) {
      majorLabel = 'Major Detailing Services';
      moderateLabel = 'Moderate Detailing Services';
      minorLabel = 'Minor Detailing Services';
    } else if (invoiceType.includes('medical')) {
      majorLabel = 'Major Procedures';
      moderateLabel = 'Moderate Procedures';
      minorLabel = 'Minor Procedures';
    } else if (invoiceType.includes('plumbing')) {
      majorLabel = 'Major Plumbing Repairs';
      moderateLabel = 'Moderate Plumbing Repairs';
      minorLabel = 'Minor Plumbing Repairs';
    }

    // ---- Dynamic reportTitle, shopLabel, footerText ----
    let reportTitle = 'Auto Service Summary';
    let shopLabel = 'Shop';
    let footerText = 'This report was generated by ServiceCipher™. Contact your repair shop with any questions.';

    if (invoiceType.includes('medical')) {
      reportTitle = 'Medical Service Summary';
      shopLabel = 'Clinic';
      footerText = 'This report was generated by ServiceCipher™. Contact your medical provider with any questions.';
    } else if (invoiceType.includes('plumbing')) {
      reportTitle = 'Plumbing Service Summary';
      shopLabel = 'Company';
      footerText = 'This report was generated by ServiceCipher™. Contact your plumbing provider with any questions.';
    } else if (invoiceType.includes('detailing')) {
      reportTitle = 'Auto Detailing Summary';
      shopLabel = 'Detailing Shop';
      footerText = 'This report was generated by ServiceCipher™. Contact your detailer with any questions.';
    }

    // Build blue cards for Reason For Visit and Summary
    const reasonCard = buildBlueCard('Reason For Visit', sections['REASON_FOR_VISIT']);
    const summaryCard = buildBlueCard('Summary', sections['REPAIR_SUMMARY']);

    // Build all other section cards
    let cardsHTML = "";
    sectionOrder.forEach(section => {
      if (
        section === 'SHOP_NAME' ||
        section === 'DATE' ||
        section === 'REASON_FOR_VISIT' ||
        section === 'REPAIR_SUMMARY'
      ) return;
      let label = prettySectionLabel(section);
      let cssClass = section.toLowerCase();
      cardsHTML += buildSectionCard(label, sections[section], cssClass);
    });

    // Load HTML template, inject content
    let htmlTemplate = fs.readFileSync(path.join(__dirname, 'templates/invoiceReport.html'), 'utf8');
    htmlTemplate = htmlTemplate
      .replace('{{REPORT_TITLE}}', reportTitle)
      .replace('{{SHOP_LABEL}}', shopLabel)
      .replace('{{FOOTER_TEXT}}', footerText)
      .replace('{{SHOP_NAME}}', getSection(sections, 'SHOP_NAME'))
      .replace('{{DATE}}', getSection(sections, 'DATE'))
      .replace('{{REASON_FOR_VISIT_CARD}}', reasonCard)
      .replace('{{REPAIR_SUMMARY_CARD}}', summaryCard)
      .replace('{{SECTION_CARD_MAJOR}}', buildSectionCard(majorLabel, sections['MAJOR'], 'major'))
      .replace('{{SECTION_CARD_MODERATE}}', buildSectionCard(moderateLabel, sections['MODERATE'], 'moderate'))
      .replace('{{SECTION_CARD_MINOR}}', buildSectionCard(minorLabel, sections['MINOR'], 'minor'))
      .replace('{{COST_BREAKDOWN_ROWS}}', sections['COST_BREAKDOWN'].map(line => {
        const idx = line.lastIndexOf(':');
        if (idx !== -1) {
          const item = cleanText(line.slice(0, idx+1));
          const price = cleanText(line.slice(idx+1)).trim();
          return `<tr><td class="cost-item">${item}</td><td class="cost-price">${price}</td></tr>`;
        } else {
          return `<tr><td class="cost-item" colspan="2">${cleanText(line)}</td></tr>`;
        }
      }).join(''))
      // .replace('{{SECTION_CARD_COST_BREAKDOWN}}', buildSectionCard('Cost Breakdown', sections['COST_BREAKDOWN'], 'cost_breakdown'))
      .replace('{{SECTION_CARD_WHAT_DOES_THIS_ACTUALLY_MEAN?}}', buildSectionCard('What Does This Actually Mean?', sections['WHAT_DOES_THIS_ACTUALLY_MEAN?'], 'education'))
      .replace('{{SECTION_CARD_OTHER_NOTES}}', buildSectionCard('Other Notes', sections['OTHER_NOTES'], 'other_notes'))
      .replace('{{SECTION_CARD_RECOMMENDATIONS}}', buildSectionCard('Recommendations', sections['RECOMMENDATIONS'], 'recommendations'));

    // Puppeteer: HTML to PDF (footer at the end, no gray space)
    const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: true });
    const pageObj = await browser.newPage();
    await pageObj.setContent(htmlTemplate, { waitUntil: 'networkidle0' });
    const pdfBuffer = await pageObj.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '22px', bottom: '80px', left: '0', right: '0' }, // bottom must match footer height
      displayHeaderFooter: true,
      headerTemplate: `<span></span>`, // keeps header empty
      footerTemplate: `
        <div style="
          width: 100%;
          font-size: 14px;
          font-family: 'Segoe UI', Arial, sans-serif;
          color: #8a97b7;
          text-align: center;
          padding: 16px 0 10px 0;
          border-top: 1.6px solid #e6ebf3;
          letter-spacing: 0.01em;
        ">
          ${footerText}<br />
          &copy; 2025 ServiceCipher™.
        </div>
      `,
    });
    await browser.close();

    // Save PDF to /tmp (cross-platform, works on Railway)
    const timestamp = Date.now();
    const pdfPath = path.join('/tmp', `ServiceCipher_Report_${timestamp}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    fs.unlinkSync(req.file.path);

    res.json({ success: true, url: `/api/download/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).json({ success: false, message: 'Processing error.' });
  }
});

app.get('/api/download/:filename', (req, res) => {
  const file = path.join('/tmp', req.params.filename);  // read from /tmp!
  res.download(file);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
