import { readFile, writeFile } from "node:fs/promises";

const dataPath = new URL("../data/programs.json", import.meta.url);
const dataset = JSON.parse(await readFile(dataPath, "utf8"));
const programs = dataset.programs ?? [];
const now = new Date();

const kstDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: false,
}).format(now);
const shortDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
}).format(now).replace(/\s/g, "").replace(/\.$/, "");

const decodeEntities = (value) => value
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const pageText = (html) => decodeEntities(html)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const compact = (value) => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s·:()\[\]{}'"“”‘’.,!?\-_/&]+/g, "");

async function fetchOfficialPage(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(18_000),
      headers: {
        "user-agent": "Baeum-Ieum public education status checker/1.0",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.5",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return { ok: true, text: pageText(html).slice(0, 2_000_000), status: response.status };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 120) };
  }
}

function inferAvailability(text, program, uniqueDetailPage) {
  const normalizedPage = compact(text);
  const normalizedTitle = compact(program.title);
  let scope = "";
  const titleIndex = normalizedPage.indexOf(normalizedTitle);
  if (titleIndex >= 0) {
    scope = normalizedPage.slice(Math.max(0, titleIndex - 700), titleIndex + normalizedTitle.length + 1_500);
  } else if (uniqueDetailPage) {
    scope = normalizedPage;
  } else {
    return null;
  }

  if (/대기신청|대기접수|대기자모집|대기예약/.test(scope)) return "대기접수";
  if (/정원마감|정원초과|모집마감|접수마감|신청마감|접수종료|모집종료/.test(scope)) return "정원마감";
  if (/접수예정|모집예정|신청예정|접수전/.test(scope)) return "접수예정";
  if (/접수중|신청가능|예약가능|모집중/.test(scope)) return "접수중";
  return null;
}

const statusFor = {
  접수중: "신청 가능",
  접수예정: "접수 예정",
  대기접수: "대기 신청",
  정원마감: "정원 마감",
  접수마감: "접수 마감",
  전화확인: "전화 확인",
};

const urlCounts = new Map();
for (const program of programs) urlCounts.set(program.url, (urlCounts.get(program.url) ?? 0) + 1);
const urls = [...urlCounts.keys()];
const results = new Map();
let cursor = 0;

async function worker() {
  while (cursor < urls.length) {
    const url = urls[cursor++];
    results.set(url, await fetchOfficialPage(url));
  }
}
await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));

let checked = 0;
let failed = 0;
let changed = 0;
const updatedPrograms = programs.map((program) => {
  const result = results.get(program.url);
  const next = { ...program };
  delete next.change;
  next.lastCheckedAt = now.toISOString();

  if (!result?.ok) {
    failed += 1;
    next.sourceStatus = "확인 실패";
    next.sourceError = result?.error ?? "응답 없음";
    return next;
  }

  checked += 1;
  next.sourceStatus = "확인됨";
  next.lastSuccessfulAt = now.toISOString();
  next.verified = shortDate;
  delete next.sourceError;

  const inferred = inferAvailability(result.text, program, urlCounts.get(program.url) === 1);
  if (inferred && inferred !== program.availability) {
    next.availability = inferred;
    next.status = statusFor[inferred] ?? program.status;
    next.change = "상태변경";
    changed += 1;
  }
  return next;
});

const nextDataset = {
  ...dataset,
  schemaVersion: 1,
  collectedAt: kstDate,
  collectedAtIso: now.toISOString(),
  sourceCount: urls.length,
  stats: { programs: updatedPrograms.length, checked, failed, changed },
  programs: updatedPrograms,
};

await writeFile(dataPath, `${JSON.stringify(nextDataset, null, 2)}\n`, "utf8");
console.log(JSON.stringify(nextDataset.stats));
