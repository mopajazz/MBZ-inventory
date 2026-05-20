const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const TYPE_RULES = {
  lesson: {
    severity: "critical",
    reason: "Moodle Lessons can contain branching navigation, embedded questions, and attempt logic that Canvas does not mirror directly.",
    recommendation: "Rebuild as Canvas pages, quizzes, and module requirements after reviewing each branch."
  },
  scorm: {
    severity: "critical",
    reason: "SCORM packages usually rely on a runtime player and tracking model outside native Canvas content.",
    recommendation: "Keep the package for manual review, then decide whether to host externally or rebuild as Canvas-native content."
  },
  h5p: {
    severity: "critical",
    reason: "H5P activities may depend on Moodle plugins, libraries, and interaction data that need separate Canvas planning.",
    recommendation: "Inventory the interaction type and rebuild or embed with an approved H5P/LTI workflow."
  },
  book: {
    severity: "high",
    reason: "Moodle Books have chapter structure that often needs deliberate Canvas page and module mapping.",
    recommendation: "Convert chapters into Canvas pages and preserve order inside the target module."
  },
  forum: {
    severity: "high",
    reason: "Forum prompts, settings, groups, subscriptions, and historical discussion data need human review.",
    recommendation: "Recreate as Canvas discussions and verify grading, groups, and availability settings."
  },
  page: {
    severity: "medium",
    reason: "Pages usually migrate as content, but embedded links, media, and filters may need cleanup.",
    recommendation: "Review links, images, accessibility, and formatting after import."
  },
  file: {
    severity: "medium",
    reason: "Files are usually portable, but references, folders, permissions, and embedded links can break.",
    recommendation: "Move into Canvas files and verify every place the file is linked from course content."
  },
  url: {
    severity: "low",
    reason: "External URLs are simple references, though link freshness and display behavior still matter.",
    recommendation: "Recreate as Canvas external URL items and check that each destination is current."
  }
};

const DEFAULT_RULE = {
  severity: "medium",
  reason: "This Moodle activity type needs review because its Canvas mapping is not yet classified in this slice.",
  recommendation: "Inspect the item and choose an appropriate Canvas content type before migration."
};

export { SEVERITY_ORDER, TYPE_RULES };

export async function analyzeMbzFile(file) {
  const buffer = await file.arrayBuffer();
  return analyzeMbzBuffer(buffer, file.name);
}

export async function analyzeMbzBuffer(buffer, fileName = "course.mbz") {
  const entries = await readArchiveEntries(buffer, fileName);
  const inventory = parseCourseInventory(entries).map(classifyCourseItem);

  return {
    fileName,
    items: sortItemsForReadiness(inventory),
    counts: countBySeverity(inventory)
  };
}

export function parseCourseInventory(entries) {
  const activityDirs = new Map();
  const sectionsById = parseSections(entries);

  for (const [path, text] of entries) {
    const match = path.match(/^activities\/([^/]+)\/([^/]+\.xml)$/i);
    if (!match) continue;

    const [, dir, fileName] = match;
    const current = activityDirs.get(dir) ?? { dir };
    current.type = current.type ?? dir.split("_")[0].toLowerCase();

    if (fileName.toLowerCase() === "module.xml") {
      current.moduleId = getXmlValue(text, "moduleid") ?? getXmlAttribute(text, "module", "id") ?? current.moduleId;
      current.type = (getXmlValue(text, "modulename") ?? current.type).toLowerCase();
      current.sectionId = getXmlValue(text, "sectionid") ?? current.sectionId;
      current.visible = getXmlValue(text, "visible") ?? current.visible;
    } else if (fileName.toLowerCase() === `${current.type}.xml`) {
      current.name = decodeXml(getXmlValue(text, "name")) ?? current.name;
      current.activityId = getXmlAttribute(text, current.type, "id") ?? current.activityId;
    }

    activityDirs.set(dir, current);
  }

  return [...activityDirs.values()]
    .filter((item) => item.type)
    .map((item, index) => {
      const section = sectionsById.get(item.sectionId) ?? {};
      return {
        id: item.moduleId ?? item.activityId ?? item.dir ?? String(index + 1),
        title: item.name ?? titleCase(item.type),
        moodleType: item.type,
        moduleName: section.name ?? `Section ${item.sectionId ?? "Unknown"}`,
        sectionId: item.sectionId ?? "unknown",
        sectionOrder: section.order ?? 9999,
        originalPath: `activities/${item.dir}`
      };
    });
}

export function classifyCourseItem(item) {
  const rule = TYPE_RULES[item.moodleType] ?? DEFAULT_RULE;
  return {
    ...item,
    severity: rule.severity,
    riskReason: rule.reason,
    canvasRecommendation: rule.recommendation
  };
}

export function countBySeverity(items) {
  const counts = { total: items.length, critical: 0, high: 0, medium: 0, low: 0 };

  for (const item of items) {
    counts[item.severity] += 1;
  }

  return counts;
}

export function groupItemsBySeverity(items) {
  const grouped = new Map(SEVERITY_ORDER.map((severity) => [severity, new Map()]));

  for (const item of sortItemsForReadiness(items)) {
    const sectionMap = grouped.get(item.severity);
    const key = item.moduleName;
    const sectionItems = sectionMap.get(key) ?? [];
    sectionItems.push(item);
    sectionMap.set(key, sectionItems);
  }

  return grouped;
}

export function sortItemsForReadiness(items) {
  return [...items].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severityDelta !== 0) return severityDelta;

    const sectionDelta = Number(a.sectionOrder) - Number(b.sectionOrder);
    if (sectionDelta !== 0) return sectionDelta;

    return a.title.localeCompare(b.title);
  });
}

async function readArchiveEntries(buffer, fileName) {
  const bytes = new Uint8Array(buffer);

  if (isZip(bytes)) {
    return readZipEntries(bytes);
  }

  if (isGzip(bytes) || fileName.endsWith(".tgz") || fileName.endsWith(".tar.gz")) {
    const decompressed = await decompress(bytes, "gzip");
    return readTarEntries(new Uint8Array(decompressed));
  }

  return readTarEntries(bytes);
}

function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isGzip(bytes) {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function readZipEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;

  while (offset < bytes.length - 30) {
    const signature = readUint32(bytes, offset);
    if (signature !== 0x04034b50) break;

    const compression = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const fileNameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const name = decoder.decode(bytes.slice(nameStart, nameEnd)).replace(/\\/g, "/");
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const data = bytes.slice(dataStart, dataEnd);

    if (!name.endsWith("/") && name.endsWith(".xml")) {
      const content = compression === 0 ? data : new Uint8Array(await decompress(data, "deflate-raw"));
      entries.set(name, decoder.decode(content));
    }

    offset = dataEnd;
  }

  return entries;
}

function readTarEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    const name = readNullTerminated(decoder, header.slice(0, 100));
    if (!name) break;

    const sizeText = readNullTerminated(decoder, header.slice(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (name.endsWith(".xml")) {
      entries.set(name.replace(/\\/g, "/"), decoder.decode(bytes.slice(dataStart, dataEnd)));
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

async function decompress(bytes, format) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress compressed MBZ archives.");
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).arrayBuffer();
}

function parseSections(entries) {
  const sections = new Map();
  let order = 0;

  for (const [path, text] of entries) {
    if (!path.match(/^sections\/[^/]+\/section\.xml$/i)) continue;

    const id = getXmlValue(text, "id") ?? getXmlAttribute(text, "section", "id");
    if (!id) continue;

    sections.set(id, {
      name: decodeXml(getXmlValue(text, "name")) ?? `Section ${id}`,
      order
    });
    order += 1;
  }

  return sections;
}

function getXmlValue(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1]?.trim() || undefined;
}

function getXmlAttribute(text, tagName, attribute) {
  const match = text.match(new RegExp(`<${tagName}\\b[^>]*\\s${attribute}="([^"]+)"`, "i"));
  return match?.[1];
}

function decodeXml(value) {
  if (!value) return value;

  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function titleCase(value) {
  return value.replace(/(^|_)([a-z])/g, (_, __, letter) => ` ${letter.toUpperCase()}`).trim();
}

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readNullTerminated(decoder, bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.slice(0, end));
}
