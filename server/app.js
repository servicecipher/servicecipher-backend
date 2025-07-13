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
const allowedEmails = require('./allowed_emails.json');
require('dotenv').config();

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
        return `<div class="card-line"><span class="card-title">${cleanText(match[1])}:</span><br>${cleanText(match[2])}</div>`;
      }
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

// --- EMAIL AUTH MIDDLEWARE ---
// Expects frontend to send "x-user-email" header
function checkEmailAllowed(req, res, next) {
  const email = req.headers['x-user-email'];
  if (!email || !allowedEmails.includes(email)) {
    return res.status(403).json({ success: false, message: 'Email not allowed' });
  }
  next();
}

app.post('/api/upload', checkEmailAllowed, upload.single('pdf'), async (req, res) => {
  console.log('ALLOWED EMAILS:', allowedEmails);
  console.log('RECEIVED HEADER x-user-email:', req.headers['x-user-email']);try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(fileBuffer);
    const invoiceText = data.text;

    // --- PROMPT (unchanged) ---
    const prompt = `
You are a professional, friendly auto service advisor. Your job is to help customers understand their auto repair invoice in plain, non-technical English — as if explaining it to someone who knows nothing about cars. Your writing must always be specific, helpful, and consistent — even if the invoice is short or vague.

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
  - For each section, list 2–4 bullet points, with each bullet explaining:  
    - What was fixed  
    - Why it mattered  
    - What could have happened if left undone  
  - If there are no items in a section, write “None.”

- **COST_BREAKDOWN:**  
  List every part, labor, fee, tax, and total as a bullet list. Include numbers if possible. Always end with the total cost.

- **WHAT_DOES_THIS ACTUALLY MEAN?:**  
  For every major part or service listed in the invoice (e.g., control arms, ball joints, alignment, brakes, ignition coils, battery), explain:  
    - What it is  
    - Why it matters  
    - What can happen if it fails  
  Do not summarize the invoice here. This section is purely educational. Use this format:

  - **Ball Joints:** Ball joints act as pivots between the wheels and the suspension. They help the car turn and move smoothly over bumps. If a ball joint fails, it can cause steering problems or make the wheel detach.

- **OTHER_NOTES:**  
  Add any warranties, reminders, or general notes from the invoice. If none are present, write: “No additional notes.”

- **RECOMMENDATIONS:**  
  If the invoice lists any recommendations (future services, maintenance reminders, or inspection suggestions), display those clearly in this section.  
  - Use the actual recommendations from the invoice as the main content.  
  - If there are no recommendations listed, provide 2–4 helpful, specific, non-salesy maintenance tips based on the repairs or inspection findings.  
  - Always write this section; never leave it blank or write "None."

---

### FORMAT RULES (CRITICAL):
- You must include every section above in the correct order, with each section header written **exactly** as shown.
- Each header must be followed by a colon and the content on the next line(s).
- Never skip or rename sections. If content is missing, provide a helpful fallback (e.g., “Not listed on the invoice”).
- Never write in paragraph form. Use clear headers, bullet lists, and short sections.
- Do not include markdown, HTML, code, or JSON.

---

INVOICE TO ANALYZE:  
--------------------  
${invoiceText}  
--------------------
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

    // Section extraction + debug log
    const sections = extractSections(summary);

    // Build blue cards for Reason For Visit and Repair Summary
    const reasonCard = buildBlueCard('Reason For Visit', sections['REASON_FOR_VISIT']);
    const summaryCard = buildBlueCard('Repair Summary', sections['REPAIR_SUMMARY']);

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
  .replace('{{SHOP_NAME}}', getSection(sections, 'SHOP_NAME'))
  .replace('{{DATE}}', getSection(sections, 'DATE'))
  .replace('{{REASON_FOR_VISIT_CARD}}', reasonCard)
  .replace('{{REPAIR_SUMMARY_CARD}}', summaryCard)
  .replace('{{SECTION_CARD_MAJOR}}', buildSectionCard('Major Repairs', sections['MAJOR'], 'major'))
  .replace('{{SECTION_CARD_MODERATE}}', buildSectionCard('Moderate Repairs', sections['MODERATE'], 'moderate'))
  .replace('{{SECTION_CARD_MINOR}}', buildSectionCard('Minor Repairs', sections['MINOR'], 'minor'))
  .replace('{{SECTION_CARD_COST_BREAKDOWN}}', buildSectionCard('Cost Breakdown', sections['COST_BREAKDOWN'], 'cost_breakdown'))
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
    This report was generated by ServiceCipher™. Contact your repair shop with any questions.<br />
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
