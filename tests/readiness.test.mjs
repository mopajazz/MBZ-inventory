import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMbzBuffer, SEVERITY_ORDER } from "../src/readiness.js";

const fixturePath = new URL("./fixtures/readiness-course.mbz", import.meta.url);

test("fixture MBZ produces expected Canvas migration readiness severity classifications", async () => {
  await writeFixtureMbz();
  const before = await sha256(fixturePath);
  const buffer = await readFile(fixturePath);

  const analysis = await analyzeMbzBuffer(buffer, "readiness-course.mbz");

  assert.deepEqual(analysis.counts, {
    total: 8,
    critical: 3,
    high: 2,
    medium: 2,
    low: 1
  });

  const severitiesByType = Object.fromEntries(analysis.items.map((item) => [item.moodleType, item.severity]));
  assert.deepEqual(severitiesByType, {
    lesson: "critical",
    scorm: "critical",
    h5p: "critical",
    book: "high",
    forum: "high",
    page: "medium",
    file: "medium",
    url: "low"
  });

  assert.deepEqual(
    [...new Set(analysis.items.map((item) => item.severity))],
    SEVERITY_ORDER
  );

  for (const item of analysis.items) {
    assert.ok(item.moodleType, `${item.title} has a Moodle type`);
    assert.ok(item.riskReason, `${item.title} has a risk reason`);
    assert.ok(item.canvasRecommendation, `${item.title} has a Canvas recommendation`);
  }

  const after = await sha256(fixturePath);
  assert.equal(after, before, "original MBZ fixture was not modified");
});

async function writeFixtureMbz() {
  await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });

  const files = new Map([
    ["sections/section_1/section.xml", sectionXml("1", "Module 1: Orientation")],
    ["sections/section_2/section.xml", sectionXml("2", "Module 2: Practice")],
    ...activity("lesson", "101", "1", "Branching Lesson"),
    ...activity("scorm", "102", "1", "Legacy SCORM Package"),
    ...activity("h5p", "103", "1", "Interactive H5P Check"),
    ...activity("book", "104", "2", "Course Handbook"),
    ...activity("forum", "105", "2", "Weekly Discussion"),
    ...activity("page", "106", "2", "Welcome Page"),
    ...activity("file", "107", "2", "Syllabus PDF"),
    ...activity("url", "108", "2", "External Resource")
  ]);

  await writeFile(fixturePath, createStoredZip(files));
}

function activity(type, id, sectionId, name) {
  return [
    [`activities/${type}_${id}/module.xml`, moduleXml(type, id, sectionId)],
    [`activities/${type}_${id}/${type}.xml`, activityXml(type, id, name)]
  ];
}

function sectionXml(id, name) {
  return `<section id="${id}">
  <id>${id}</id>
  <name>${name}</name>
</section>`;
}

function moduleXml(type, id, sectionId) {
  return `<module id="${id}">
  <moduleid>${id}</moduleid>
  <modulename>${type}</modulename>
  <sectionid>${sectionId}</sectionid>
  <visible>1</visible>
</module>`;
}

function activityXml(type, id, name) {
  return `<activity>
  <${type} id="${id}">
    <name>${name}</name>
  </${type}>
</activity>`;
}

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const contentBytes = encoder.encode(content);
    const crc = crc32(contentBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, contentBytes.length, true);
    local.setUint32(22, contentBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, contentBytes.length, true);
    central.setUint32(24, contentBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length + contentBytes.length;
  }

  const centralStart = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.size, true);
  endView.setUint16(10, files.size, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralStart, true);

  return Buffer.concat([...chunks, ...centralDirectory, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}
