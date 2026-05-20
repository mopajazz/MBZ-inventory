const ACTIONS = [
  ["preflight", "Preflight Course Audit", "Inventory course structure, activities, files, and Moodle-specific settings before Canvas import."],
  ["readiness", "Canvas Readiness Scoring", "Score activities by migration effort and identify high-touch conversion points."],
  ["links", "Broken Link Detection", "Scan HTML for external links, embeds, plugin-file placeholders, and suspicious references."],
  ["mapping", "Module Mapping Blueprint", "Convert Moodle topics or weeks into a Canvas module outline."],
  ["quiz", "Quiz And Bank Triage", "Find quiz and question-bank evidence that needs Canvas validation."],
  ["cleanup", "Content Cleanup Plan", "Find Moodle classes, inline styles, plugin placeholders, and HTML cleanup needs."],
  ["accessibility", "Accessibility Review", "Flag missing alt text, weak links, tables, media, and heading problems."],
  ["assignments", "Assignment Settings", "Extract due date, completion, grade, rubric, and plagiarism clues."],
  ["faculty", "Faculty Review Packet", "Summarize decisions instructors should make before Canvas build-out."],
  ["batch", "Batch Export Data", "Export JSON and Markdown for QA trackers, scripts, or Canvas API workflows."]
].map(([id, title, description]) => ({ id, title, description }));

const COMPAT = {
  page: ["Clean", 94, "Usually maps well to a Canvas Page."],
  label: ["Clean", 88, "Usually becomes page body text or a module text header."],
  url: ["Clean", 92, "Usually maps well to an External URL item."],
  resource: ["Clean", 90, "Usually maps to Canvas Files."],
  folder: ["Clean", 86, "May need Canvas file organization."],
  assign: ["Review", 72, "Shell migrates, but dates, rubrics, groups, and submissions need QA."],
  forum: ["Review", 58, "Discussion behavior, ratings, groups, and prompts need review."],
  quiz: ["Review", 50, "Question types and banks often need hands-on validation."],
  book: ["Review", 62, "Often becomes multiple Canvas Pages or one organized page."],
  lesson: ["Rebuild", 34, "Moodle Lesson has no direct Canvas equivalent."],
  h5pactivity: ["Rebuild", 38, "H5P package and gradebook behavior need a Canvas strategy."],
  scorm: ["Rebuild", 30, "Canvas support depends on SCORM/LTI strategy."],
  collaborate: ["Rebuild", 28, "Collaborate links usually need replacement."]
};

const state = { source: "", entries: [], analysis: null, selected: "preflight" };

const $ = (id) => document.getElementById(id);
const els = {
  actionNav: $("actionNav"),
  dropZone: $("dropZone"),
  mbzInput: $("mbzInput"),
  folderInput: $("folderInput"),
  sampleButton: $("sampleButton"),
  exportJson: $("exportJson"),
  exportMarkdown: $("exportMarkdown"),
  status: $("status"),
  sourceName: $("sourceName"),
  filesRead: $("filesRead"),
  readiness: $("readiness"),
  metrics: $("metrics"),
  layout: $("layout"),
  courseTitle: $("courseTitle"),
  courseMeta: $("courseMeta"),
  moduleRows: $("moduleRows"),
  activityRows: $("activityRows"),
  issueRows: $("issueRows"),
  actionTitle: $("actionTitle"),
  actionDescription: $("actionDescription"),
  actionOutput: $("actionOutput")
};

function init() {
  renderNav();
  els.mbzInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await loadMbz(file);
    event.target.value = "";
  });
  els.folderInput.addEventListener("change", async (event) => {
    await loadFolder(Array.from(event.target.files || []));
    event.target.value = "";
  });
  els.sampleButton.addEventListener("click", loadSample);
  els.exportJson.addEventListener("click", exportJson);
  els.exportMarkdown.addEventListener("click", exportMarkdown);

  ["dragenter", "dragover"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragging");
    });
  });
  els.dropZone.addEventListener("drop", async (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file) await loadMbz(file);
  });

  window.MbzMigrationApp = { processEntries };
  if (new URLSearchParams(location.search).has("sample")) loadSample();
}

function renderNav() {
  els.actionNav.innerHTML = "";
  for (const action of ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `nav-button${action.id === state.selected ? " active" : ""}`;
    button.textContent = action.title;
    button.addEventListener("click", () => {
      state.selected = action.id;
      renderNav();
      renderActionPanel();
    });
    els.actionNav.append(button);
  }
}

async function loadFolder(files) {
  if (!files.length) return;
  const entries = [];
  for (const file of files) {
    const path = normalize(file.webkitRelativePath || file.name);
    if (isTextPath(path)) entries.push({ path, text: await file.text(), size: file.size });
  }
  state.source = files[0].webkitRelativePath?.split("/")[0] || "Extracted Moodle backup";
  processEntries(entries);
}

async function loadMbz(file) {
  try {
    showLoading(`Reading ${file.name}...`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const tarBytes = await maybeGunzip(bytes);
    const entries = parseTar(tarBytes)
      .filter((entry) => isTextPath(entry.path))
      .map((entry) => ({ path: entry.path, size: entry.size, text: new TextDecoder().decode(entry.bytes) }));
    state.source = file.name;
    processEntries(entries);
  } catch (error) {
    els.status.hidden = false;
    els.sourceName.textContent = error.message || "Could not read backup";
  }
}

function showLoading(message) {
  els.status.hidden = false;
  els.sourceName.textContent = message;
  els.filesRead.textContent = "0";
  els.readiness.textContent = "--";
}

async function maybeGunzip(bytes) {
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzip) return bytes;
  if (!("DecompressionStream" in window)) {
    throw new Error("This browser cannot decompress gzip MBZ files. Use Chrome/Edge or choose an extracted folder.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseTar(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const path = normalize(prefix ? `${prefix}/${name}` : name);
    offset += 512;
    const fileBytes = bytes.slice(offset, offset + size);
    if (type === "0" || type === "\0") entries.push({ path, bytes: fileBytes, size });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function tarString(bytes, start, length) {
  let value = "";
  for (let index = start; index < start + length; index += 1) {
    if (!bytes[index]) break;
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

function processEntries(entries) {
  state.entries = entries;
  state.analysis = analyze(entries);
  render();
}

function analyze(entries) {
  const parser = new DOMParser();
  const docs = new Map();
  for (const entry of entries) {
    if (!/\.xml$/i.test(entry.path)) continue;
    const doc = parser.parseFromString(entry.text, "text/xml");
    if (!doc.querySelector("parsererror")) docs.set(stripRoot(entry.path), doc);
  }

  const courseDoc = firstDoc(docs, /(^|\/)course\/course\.xml$/) || firstDoc(docs, /(^|\/)course\.xml$/);
  const course = courseDoc ? {
    fullname: text(courseDoc, "fullname") || "Untitled Moodle Course",
    shortname: text(courseDoc, "shortname"),
    format: text(courseDoc, "format"),
    summary: decode(text(courseDoc, "summary")),
    start: date(text(courseDoc, "startdate")),
    end: date(text(courseDoc, "enddate")),
    completion: text(courseDoc, "enablecompletion") === "1"
  } : { fullname: "Untitled Moodle Course" };

  const files = parseFiles(firstDoc(docs, /(^|\/)files\.xml$/));
  const sections = parseSections(docs);
  const activities = parseActivities(docs);
  const htmlSources = collectHtml(course, sections, activities);
  const links = scanLinks(htmlSources);
  const accessibility = scanAccessibility(htmlSources);
  const cleanup = scanCleanup(htmlSources);
  const assignments = analyzeAssignments(activities);
  const quiz = analyzeQuiz(docs, activities);
  const activityCounts = countBy(activities, "type");

  const sectionsWithItems = sections.map((section) => {
    const items = activities.filter((activity) => String(activity.sectionId) === String(section.id) || Number(activity.sectionNumber) === Number(section.number));
    const score = items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 100;
    return { ...section, items, score, risk: riskLabel(score) };
  });

  const readiness = scoreReadiness(activities, links, accessibility, cleanup);
  const issues = buildIssues({ activities, links, accessibility, cleanup, files, quiz });
  const exports = { generatedAt: new Date().toISOString(), course, readiness, counts: { sections: sections.length, activities: activities.length, files: files.length, links: links.length, accessibility: accessibility.length, cleanup: cleanup.length }, activityCounts, sections: sectionsWithItems, activities, files, links, accessibility, cleanup, assignments, quiz, issues };
  return { course, files, sections: sectionsWithItems, activities, links, accessibility, cleanup, assignments, quiz, activityCounts, readiness, issues, exports };
}

function parseFiles(doc) {
  if (!doc) return [];
  return Array.from(doc.querySelectorAll("file")).map((node) => ({
    id: node.getAttribute("id"),
    filename: text(node, "filename"),
    hash: text(node, "contenthash"),
    component: text(node, "component"),
    filearea: text(node, "filearea"),
    mimetype: text(node, "mimetype"),
    size: Number(text(node, "filesize")) || 0,
    author: text(node, "author"),
    license: text(node, "license")
  })).filter((file) => file.filename && file.filename !== ".");
}

function parseSections(docs) {
  const sections = [];
  for (const [path, doc] of docs) {
    if (!/(^|\/)sections\/section_[^/]+\/section\.xml$/.test(path)) continue;
    const root = doc.querySelector("section");
    sections.push({
      id: root?.getAttribute("id") || path.match(/section_(\d+)/)?.[1] || "",
      number: Number(text(doc, "number")),
      name: text(doc, "name") || `Section ${text(doc, "number") || sections.length + 1}`,
      summary: decode(text(doc, "summary")),
      sequence: text(doc, "sequence").split(",").filter(Boolean),
      visible: text(doc, "visible") !== "0"
    });
  }
  return sections.sort((a, b) => a.number - b.number);
}

function parseActivities(docs) {
  const activities = [];
  for (const [path, moduleDoc] of docs) {
    if (!/(^|\/)activities\/[^/]+\/module\.xml$/.test(path)) continue;
    const folder = path.replace(/\/module\.xml$/, "");
    const type = text(moduleDoc, "modulename") || folder.match(/activities\/([^_]+)/)?.[1] || "activity";
    const doc = docs.get(`${folder}/${type}.xml`) || firstDoc(docs, new RegExp(`^${escapeRegExp(folder)}/(?!module)[^/]+\\.xml$`));
    const [readiness, score, note] = COMPAT[type] || ["Review", 60, "Needs validation against Canvas behavior."];
    const content = activityContent(doc, type);
    activities.push({
      id: moduleDoc.querySelector("module")?.getAttribute("id") || "",
      type,
      name: content.name || text(doc || moduleDoc, "name") || `${type} ${activities.length + 1}`,
      sectionId: text(moduleDoc, "sectionid"),
      sectionNumber: text(moduleDoc, "sectionnumber"),
      visible: text(moduleDoc, "visible") !== "0",
      completion: text(moduleDoc, "completion"),
      completionExpected: date(text(moduleDoc, "completionexpected")),
      readiness,
      score,
      note,
      html: content.html,
      settings: content.settings,
      path: folder
    });
  }
  return activities;
}

function activityContent(doc, type) {
  if (!doc) return { name: "", html: "", settings: {} };
  const html = [text(doc, "intro"), text(doc, "content"), text(doc, "summary")].map(decode).filter(Boolean).join("\n");
  const settings = {};
  if (type === "assign") {
    ["duedate", "allowsubmissionsfromdate", "cutoffdate", "grade", "teamsubmission", "blindmarking"].forEach((field) => {
      const raw = text(doc, field);
      if (raw) settings[field] = field.includes("date") ? date(raw) : raw;
    });
  }
  if (type === "url") settings.externalurl = text(doc, "externalurl");
  return { name: text(doc, "name"), html, settings };
}

function collectHtml(course, sections, activities) {
  const sources = [];
  if (course.summary) sources.push({ owner: "Course summary", type: "course", html: course.summary });
  sections.forEach((section) => section.summary && sources.push({ owner: section.name, type: "section", html: section.summary }));
  activities.forEach((activity) => activity.html && sources.push({ owner: activity.name, type: activity.type, html: activity.html }));
  return sources;
}

function scanLinks(sources) {
  const parser = new DOMParser();
  const findings = [];
  for (const source of sources) {
    const doc = parser.parseFromString(`<main>${source.html}</main>`, "text/html");
    doc.querySelectorAll("a[href], img[src], iframe[src], video[src], source[src], audio[src]").forEach((node) => {
      const attr = node.hasAttribute("href") ? "href" : "src";
      const url = node.getAttribute(attr) || "";
      findings.push({ owner: source.owner, type: source.type, tag: node.tagName.toLowerCase(), text: (node.textContent || node.getAttribute("alt") || "").trim(), url, category: urlCategory(url) });
    });
  }
  return findings;
}

function scanAccessibility(sources) {
  const parser = new DOMParser();
  const issues = [];
  for (const source of sources) {
    const doc = parser.parseFromString(`<main>${source.html}</main>`, "text/html");
    doc.querySelectorAll("img").forEach((img) => {
      if (!img.hasAttribute("alt") || !img.getAttribute("alt")?.trim()) issues.push({ owner: source.owner, issue: "Image missing alt text", severity: "warning" });
    });
    doc.querySelectorAll("a[href]").forEach((link) => {
      const label = link.textContent.trim().toLowerCase();
      if (!label || ["click here", "here", "read more", "link"].includes(label)) issues.push({ owner: source.owner, issue: "Weak or empty link text", severity: "warning" });
    });
    if (doc.querySelector("table")) issues.push({ owner: source.owner, issue: "Table needs header and reading-order review", severity: "info" });
    if (doc.querySelector("video,audio,iframe")) issues.push({ owner: source.owner, issue: "Media needs caption/transcript check", severity: "info" });
  }
  return issues;
}

function scanCleanup(sources) {
  const patterns = [
    ["Moodle plugin-file placeholder", /@@PLUGINFILE@@|\$@FILEPHP@\$/i, "warning"],
    ["Inline style cleanup", /style="/i, "info"],
    ["Moodle/Atto class cleanup", /class="[^"]*(atto_|img-responsive|box-shadow|h-)/i, "info"],
    ["Nonbreaking-space clutter", /&nbsp;|\u00a0|Â/i, "info"],
    ["Embedded iframe or media", /<(iframe|video|audio)\b/i, "warning"]
  ];
  const findings = [];
  for (const source of sources) {
    for (const [issue, test, severity] of patterns) {
      if (test.test(source.html)) findings.push({ owner: source.owner, issue, severity });
    }
  }
  return findings;
}

function analyzeAssignments(activities) {
  return activities.filter((activity) => activity.type === "assign").map((activity) => ({
    name: activity.name,
    settings: activity.settings,
    risks: [
      activity.settings.duedate ? "" : "No due date found",
      activity.completion && activity.completion !== "0" ? "Completion settings need Canvas equivalent" : "",
      "Submission type, rubric, plagiarism settings, and group behavior require QA"
    ].filter(Boolean)
  }));
}

function analyzeQuiz(docs, activities) {
  const quizActivities = activities.filter((activity) => activity.type === "quiz");
  const questionsDoc = firstDoc(docs, /(^|\/)questions\.xml$/);
  const nodes = questionsDoc ? Array.from(questionsDoc.querySelectorAll("question")) : [];
  return { quizActivities, questionCount: nodes.length, questionTypes: countArray(nodes.map((node) => node.getAttribute("type") || text(node, "qtype") || "unknown")) };
}

function scoreReadiness(activities, links, accessibility, cleanup) {
  if (!activities.length) return { score: 0, label: "No activities found" };
  const base = activities.reduce((sum, activity) => sum + activity.score, 0) / activities.length;
  const penalty = Math.min(24, links.filter((link) => link.category === "Moodle placeholder").length * 0.5 + accessibility.length * 0.6 + cleanup.filter((item) => item.severity === "warning").length * 1.2);
  const score = Math.max(0, Math.round(base - penalty));
  return { score, label: riskLabel(score) };
}

function buildIssues(data) {
  const issues = [];
  const rebuild = data.activities.filter((activity) => activity.readiness === "Rebuild");
  if (rebuild.length) issues.push({ severity: "danger", title: `${rebuild.length} activities likely need rebuilding`, detail: summarize(rebuild.map((activity) => `${activity.name} (${activity.type})`)) });
  const placeholders = data.links.filter((link) => link.category === "Moodle placeholder");
  if (placeholders.length) issues.push({ severity: "warning", title: `${placeholders.length} Moodle plugin-file references`, detail: "Canvas import must relink these to Canvas Files or rebuilt page assets." });
  if (data.accessibility.length) issues.push({ severity: "warning", title: `${data.accessibility.length} accessibility review flags`, detail: summarize(data.accessibility.slice(0, 5).map((item) => `${item.owner}: ${item.issue}`)) });
  if (data.cleanup.length) issues.push({ severity: "info", title: `${data.cleanup.length} HTML cleanup flags`, detail: summarize(data.cleanup.slice(0, 5).map((item) => `${item.owner}: ${item.issue}`)) });
  const unknown = data.files.filter((file) => !file.license || file.license === "unknown");
  if (unknown.length) issues.push({ severity: "info", title: `${unknown.length} files have unknown license metadata`, detail: "Useful for copyright review before republishing inside Canvas." });
  if (data.quiz.quizActivities.length || data.quiz.questionCount) issues.push({ severity: "warning", title: "Quiz/question bank review required", detail: `${data.quiz.quizActivities.length} quiz activities and ${data.quiz.questionCount} question records found.` });
  return issues;
}

function render() {
  const a = state.analysis;
  els.status.hidden = false;
  els.metrics.hidden = false;
  els.layout.hidden = false;
  els.exportJson.disabled = false;
  els.exportMarkdown.disabled = false;
  els.sourceName.textContent = state.source;
  els.filesRead.textContent = state.entries.length.toLocaleString();
  els.readiness.textContent = `${a.readiness.score}/100`;

  renderMetrics(a);
  renderOverview(a);
  renderModules(a);
  renderActivities(a);
  renderIssues(a);
  renderActionPanel();
}

function renderMetrics(a) {
  const metrics = [
    ["Sections", a.sections.length, "Moodle topics/weeks"],
    ["Activities", a.activities.length, "Module items"],
    ["Files", a.files.length, "Backup assets"],
    ["Links", a.links.length, "HTML references"],
    ["Flags", a.issues.length, "Migration concerns"]
  ];
  els.metrics.innerHTML = metrics.map(([label, value, detail]) => `<article class="metric"><span>${label}</span><strong>${value.toLocaleString()}</strong><p>${detail}</p></article>`).join("");
}

function renderOverview(a) {
  els.courseTitle.textContent = a.course.fullname;
  const meta = [
    ["Shortname", a.course.shortname || "Not found"],
    ["Format", a.course.format || "Not found"],
    ["Completion", a.course.completion ? "Enabled" : "Not enabled"],
    ["Dates", [a.course.start, a.course.end].filter(Boolean).join(" to ") || "Not found"]
  ];
  els.courseMeta.innerHTML = meta.map(([label, value]) => `<div class="meta-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function renderModules(a) {
  els.moduleRows.innerHTML = a.sections.map((section) => `<tr><td><strong>${escapeHtml(section.name)}</strong></td><td>${section.number}</td><td>${section.items.length} items</td><td><span class="pill ${riskClass(section.risk)}">${section.risk}</span></td></tr>`).join("");
}

function renderActivities(a) {
  const rows = Object.entries(a.activityCounts).sort((x, y) => y[1] - x[1]).map(([type, count]) => {
    const [label, , note] = COMPAT[type] || ["Review", 60, "Needs Canvas validation."];
    return `<article class="row"><span class="pill ${label === "Rebuild" ? "danger" : label === "Review" ? "warn" : ""}">${escapeHtml(type)}</span><div><h3>${count} ${count === 1 ? "item" : "items"}</h3><p>${escapeHtml(note)}</p></div><span class="pill info">${label}</span></article>`;
  });
  els.activityRows.innerHTML = rows.join("") || "<p>No activity module records were found.</p>";
}

function renderIssues(a) {
  els.issueRows.innerHTML = a.issues.map((issue) => `<article class="row"><span class="pill ${issue.severity === "danger" ? "danger" : issue.severity === "warning" ? "warn" : "info"}">${issue.severity}</span><div><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.detail)}</p></div><span></span></article>`).join("") || "<p>No major migration issues were detected.</p>";
}

function renderActionPanel() {
  const action = ACTIONS.find((item) => item.id === state.selected) || ACTIONS[0];
  els.actionTitle.textContent = action.title;
  els.actionDescription.textContent = action.description;
  if (!state.analysis) {
    els.actionOutput.innerHTML = `<div class="output-item"><h3>Waiting for backup</h3><p>Choose an MBZ, folder, or sample to generate this action.</p></div>`;
    return;
  }
  els.actionOutput.innerHTML = actionOutput(action.id).map((item) => `<div class="output-item"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></div>`).join("");
}

function actionOutput(id) {
  const a = state.analysis;
  const topTypes = Object.entries(a.activityCounts).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([type, count]) => `${type}: ${count}`).join(", ") || "No activities found.";
  const outputs = {
    preflight: [{ title: "Inventory", detail: `${a.sections.length} sections, ${a.activities.length} activities, ${a.files.length} files, and ${a.links.length} links found.` }, { title: "Top activity types", detail: topTypes }],
    readiness: [{ title: `Overall score: ${a.readiness.score}/100`, detail: `${a.readiness.label} migration risk based on activity types and content flags.` }, { title: "Review-heavy items", detail: summarize(a.activities.filter((activity) => activity.readiness !== "Clean").slice(0, 8).map((activity) => `${activity.name} (${activity.type})`)) || "No review-heavy activity types found." }],
    links: [{ title: "External references", detail: `${a.links.filter((link) => link.category === "External").length} external links or embeds found.` }, { title: "Moodle placeholders", detail: `${a.links.filter((link) => link.category === "Moodle placeholder").length} plugin-file placeholders need Canvas relinking.` }],
    mapping: [{ title: "Canvas modules", detail: `${a.sections.length} module candidates generated from Moodle section order.` }, { title: "Highest-risk module", detail: [...a.sections].sort((x, y) => x.score - y.score)[0]?.name || "No sections found." }],
    quiz: [{ title: "Quiz activities", detail: `${a.quiz.quizActivities.length} quiz modules found.` }, { title: "Question records", detail: `${a.quiz.questionCount} question records found. Types: ${Object.entries(a.quiz.questionTypes).map(([type, count]) => `${type}: ${count}`).join(", ") || "none"}.` }],
    cleanup: [{ title: "Cleanup flags", detail: `${a.cleanup.length} HTML cleanup flags found.` }, { title: "Common cleanup", detail: summarize(Object.entries(countArray(a.cleanup.map((item) => item.issue))).sort((x, y) => y[1] - x[1]).map(([issue, count]) => `${issue}: ${count}`)) || "No cleanup flags found." }],
    accessibility: [{ title: "Accessibility flags", detail: `${a.accessibility.length} issues found.` }, { title: "First review targets", detail: summarize(a.accessibility.slice(0, 6).map((item) => `${item.owner}: ${item.issue}`)) || "No accessibility issues found." }],
    assignments: [{ title: "Assignments", detail: `${a.assignments.length} Moodle assignments found.` }, { title: "Settings to validate", detail: summarize(a.assignments.slice(0, 5).map((item) => `${item.name}: ${item.risks.join(", ")}`)) || "No assignments found." }],
    faculty: [{ title: "Faculty decision packet", detail: `${a.issues.length} issue groups and ${a.activities.filter((activity) => activity.readiness !== "Clean").length} review-heavy items are ready for review.` }, { title: "Recommended conversation", detail: "Confirm rebuild strategy for Lessons, H5P/SCORM, quizzes, Collaborate links, and unknown-license files." }],
    batch: [{ title: "JSON export", detail: "Structured data includes course, modules, activities, files, links, issues, assignments, quiz triage, and accessibility flags." }, { title: "Review packet export", detail: "Markdown report can be pasted into a tracker, faculty email, or migration notes document." }]
  };
  return outputs[id] || outputs.preflight;
}

function exportJson() {
  if (!state.analysis) return;
  download(`${safeName(state.analysis.course.fullname)}-mbz-analysis.json`, JSON.stringify(state.analysis.exports, null, 2), "application/json");
}

function exportMarkdown() {
  if (!state.analysis) return;
  const a = state.analysis;
  const lines = [
    `# ${a.course.fullname} - Canvas Migration Review Packet`,
    "",
    `Generated: ${new Date().toLocaleString()}`,
    `Readiness: ${a.readiness.score}/100 (${a.readiness.label})`,
    "",
    "## Snapshot",
    `- Sections: ${a.sections.length}`,
    `- Activities: ${a.activities.length}`,
    `- Files: ${a.files.length}`,
    `- Links/embeds: ${a.links.length}`,
    `- Accessibility flags: ${a.accessibility.length}`,
    "",
    "## Activity Types",
    ...Object.entries(a.activityCounts).sort((x, y) => y[1] - x[1]).map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Canvas Module Blueprint",
    ...a.sections.map((section) => `- ${section.name}: ${section.items.length} items, ${section.risk} risk`),
    "",
    "## Migration Issues",
    ...(a.issues.length ? a.issues.map((issue) => `- ${issue.title}: ${issue.detail}`) : ["- No major issues detected."]),
    "",
    "## Faculty Decisions",
    "- Confirm rebuild plan for Moodle Lesson, H5P, SCORM, Collaborate, and quiz content.",
    "- Confirm whether files with unknown license metadata can be republished in Canvas.",
    "- Confirm whether old LMS references, support contacts, and screenshots should be updated for Canvas."
  ];
  download(`${safeName(a.course.fullname)}-faculty-review.md`, lines.join("\n"), "text/markdown");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function loadSample() {
  state.source = "Sample Moodle backup";
  processEntries([
    { path: "course/course.xml", size: 1, text: `<?xml version="1.0"?><course><shortname>DEMO101</shortname><fullname>Demo Canvas Migration Course</fullname><summary>&lt;p&gt;Sample summary.&lt;/p&gt;</summary><format>topics</format><startdate>1767225600</startdate><enablecompletion>1</enablecompletion></course>` },
    { path: "sections/section_1/section.xml", size: 1, text: `<?xml version="1.0"?><section id="1"><number>1</number><name>Welcome Module</name><summary>&lt;p&gt;Start with &lt;a href="https://example.edu"&gt;orientation&lt;/a&gt;.&lt;/p&gt;</summary><sequence>10,11,12</sequence><visible>1</visible></section>` },
    { path: "activities/page_10/module.xml", size: 1, text: `<?xml version="1.0"?><module id="10"><modulename>page</modulename><sectionid>1</sectionid><sectionnumber>1</sectionnumber><visible>1</visible><completion>1</completion></module>` },
    { path: "activities/page_10/page.xml", size: 1, text: `<?xml version="1.0"?><activity><page><name>Course Overview</name><content>&lt;p style="color:red"&gt;&lt;img src="@@PLUGINFILE@@/overview.png"&gt;Click &lt;a href="#"&gt;here&lt;/a&gt; for the overview.&lt;/p&gt;</content></page></activity>` },
    { path: "activities/lesson_11/module.xml", size: 1, text: `<?xml version="1.0"?><module id="11"><modulename>lesson</modulename><sectionid>1</sectionid><sectionnumber>1</sectionnumber><visible>1</visible><completion>2</completion></module>` },
    { path: "activities/lesson_11/lesson.xml", size: 1, text: `<?xml version="1.0"?><activity><lesson><name>Branching Practice Lesson</name><intro>&lt;p&gt;Moodle Lesson activity.&lt;/p&gt;</intro></lesson></activity>` },
    { path: "activities/assign_12/module.xml", size: 1, text: `<?xml version="1.0"?><module id="12"><modulename>assign</modulename><sectionid>1</sectionid><sectionnumber>1</sectionnumber><visible>1</visible><completion>2</completion></module>` },
    { path: "activities/assign_12/assign.xml", size: 1, text: `<?xml version="1.0"?><activity><assign><name>Reflection Submission</name><intro>&lt;p&gt;Submit your reflection.&lt;/p&gt;</intro><duedate>1772323200</duedate><grade>100</grade></assign></activity>` },
    { path: "files.xml", size: 1, text: `<?xml version="1.0"?><files><file id="1"><contenthash>abc</contenthash><component>mod_page</component><filearea>content</filearea><filename>overview.png</filename><filesize>12000</filesize><mimetype>image/png</mimetype><license>unknown</license></file></files>` },
    { path: "questions.xml", size: 1, text: `<?xml version="1.0"?><question_categories><question type="multichoice"><name>Sample question</name></question></question_categories>` }
  ]);
}

function firstDoc(docs, regex) {
  for (const [path, doc] of docs) if (regex.test(path)) return doc;
  return null;
}

function stripRoot(path) {
  const parts = normalize(path).split("/");
  const index = parts.findIndex((part) => ["activities", "sections", "course", "files.xml", "moodle_backup.xml", "questions.xml"].includes(part));
  return index >= 0 ? parts.slice(index).join("/") : parts.join("/");
}

function isTextPath(path) {
  return /\.(xml|html|htm|txt|json)$/i.test(path) || /moodle_backup\.log$/i.test(path);
}

function normalize(path) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function text(node, selector) {
  return node?.querySelector(selector)?.textContent?.trim().replaceAll("$@NULL@$", "") || "";
}

function decode(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value || "";
  return textarea.value;
}

function date(value) {
  const number = Number(value);
  return number ? new Date(number * 1000).toLocaleDateString() : "";
}

function urlCategory(url) {
  if (!url) return "Suspicious";
  if (url.includes("@@PLUGINFILE@@") || url.includes("$@FILEPHP@$")) return "Moodle placeholder";
  if (/^https?:\/\//i.test(url)) return "External";
  if (/^mailto:/i.test(url)) return "Email";
  if (/^#/.test(url)) return "Anchor";
  if (/^\/|^\.\.?\//.test(url)) return "Relative";
  return "Suspicious";
}

function riskLabel(score) {
  if (score >= 82) return "Low";
  if (score >= 62) return "Moderate";
  return "High";
}

function riskClass(label) {
  if (label === "High") return "danger";
  if (label === "Moderate") return "warn";
  return "";
}

function countBy(items, key) {
  return countArray(items.map((item) => item[key] || "unknown"));
}

function countArray(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function summarize(items) {
  if (!items.length) return "";
  if (items.length <= 4) return items.join("; ");
  return `${items.slice(0, 4).join("; ")}; and ${items.length - 4} more`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeName(value) {
  return String(value || "course").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

init();
