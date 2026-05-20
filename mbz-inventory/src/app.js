import { analyzeMbzFile, groupItemsBySeverity, SEVERITY_ORDER } from "./readiness.js";

const fileInput = document.querySelector("#mbz-file");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const inventory = document.querySelector("#inventory");

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  status.textContent = `Reading ${file.name} for Canvas migration readiness.`;
  results.classList.add("is-empty");

  try {
    const analysis = await analyzeMbzFile(file);
    renderAnalysis(analysis);
    status.textContent = `Inventory complete for ${analysis.fileName}. Original MBZ was read only, not modified.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to read this MBZ file.";
  }
});

function renderAnalysis(analysis) {
  for (const [key, count] of Object.entries(analysis.counts)) {
    document.querySelector(`#count-${key}`).textContent = String(count);
  }

  inventory.replaceChildren(...renderSeverityGroups(analysis.items));
  results.classList.remove("is-empty");
}

function renderSeverityGroups(items) {
  const grouped = groupItemsBySeverity(items);

  return SEVERITY_ORDER.map((severity) => {
    const sectionMap = grouped.get(severity);
    const count = [...sectionMap.values()].flat().length;
    const group = element("section", "severity-group");
    group.dataset.severity = severity;

    const heading = element("div", "severity-heading");
    heading.append(
      element("h2", "", `${capitalize(severity)} risk`),
      element("span", "item-meta", `${count} item${count === 1 ? "" : "s"}`)
    );
    group.append(heading);

    if (count === 0) {
      group.append(element("p", "item-meta", "No items in this severity group."));
      return group;
    }

    for (const [sectionName, sectionItems] of sectionMap) {
      const section = element("section", "section-group");
      section.append(element("h3", "section-title", sectionName));
      section.append(...sectionItems.map(renderItem));
      group.append(section);
    }

    return group;
  });
}

function renderItem(item) {
  const card = element("article", "item-card");
  card.dataset.severity = item.severity;

  const identity = element("div");
  identity.append(
    element("h4", "item-title", item.title),
    element("p", "item-meta", `Moodle type: ${item.moodleType}`)
  );

  const reason = renderDetail("Risk reason", item.riskReason);
  const recommendation = renderDetail("Canvas recommendation", item.canvasRecommendation);

  card.append(identity, reason, recommendation);
  return card;
}

function renderDetail(label, text) {
  const detail = element("div");
  detail.append(
    element("span", "detail-label", label),
    element("p", "detail-text", text)
  );
  return detail;
}

function element(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
