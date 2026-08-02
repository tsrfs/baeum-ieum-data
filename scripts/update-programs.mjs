import { readFile, writeFile } from "node:fs/promises";

const dataPath = new URL("../data/programs.json", import.meta.url);
const sourcesPath = new URL("../data/sources.json", import.meta.url);
const dataset = JSON.parse(await readFile(dataPath, "utf8"));
const discoverySources = JSON.parse(await readFile(sourcesPath, "utf8"));
const programs = dataset.programs ?? [];
const now = new Date();
const dryRun = process.env.DISCOVERY_DRY_RUN === "1";

const kstDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: false,
}).format(now);
const shortDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "numeric", day: "numeric",
}).format(now).replace(/\s/g, "").replace(/\.$/, "");

const decodeEntities = (value = "") => value
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const plainText = (html = "") => decodeEntities(html)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const compact = (value = "") => value.normalize("NFKC").toLowerCase()
  .replace(/[\s·:()\[\]{}'"“”‘’.,!?\-_/&]+/g, "");

const cleanTitle = (value = "") => plainText(value)
  .replace(/^\s*(새글|공지|접수중|마감|대기)\s*/gi, "")
  .replace(/\s+/g, " ").trim();

function courseTitle(value = "") {
  let title = cleanTitle(value);
  if (/html\s*\+=|바로가기\s*["']?$/.test(title)) return "";
  const cardTitle = title.match(/(?:신청\s*\/\s*)?정원\s*:\s*[0-9,]+\s+(.+?)\s+접수기간\s*:/i);
  if (cardTitle) title = cardTitle[1];
  title = title
    .replace(/^무료\s*(?:선착순\s*)?(?:행사\/지원사업\s*)?(?:행사참여\s*)?/i, "")
    .replace(/\s+(?:교육장소명|이용대상|접수기간|이용기간)\s+.*$/i, "")
    .replace(/\s+\d{4}\.\d{2}\.\d{2}\s*$/, "")
    .replace(/\s+/g, " ").trim();
  return title;
}

const requestHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 Baeum-Ieum/2.1",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.5",
};

async function fetchOfficialPage(url) {
  let lastError = "응답 없음";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow", signal: AbortSignal.timeout(22_000), headers: requestHeaders,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      return {
        ok: true, html: html.slice(0, 3_000_000), text: plainText(html).slice(0, 2_000_000),
        status: response.status, finalUrl: response.url,
      };
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 160);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 700)));
    }
  }
  return { ok: false, error: lastError };
}

async function fetchMany(urls, concurrency = 8) {
  const unique = [...new Set(urls)];
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const url = unique[cursor++];
      results.set(url, await fetchOfficialPage(url));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}

function inferAvailability(text, program, uniqueDetailPage) {
  const normalizedPage = compact(text);
  const normalizedTitle = compact(program.title);
  let scope = "";
  const titleIndex = normalizedPage.indexOf(normalizedTitle);
  if (titleIndex >= 0) scope = normalizedPage.slice(Math.max(0, titleIndex - 700), titleIndex + normalizedTitle.length + 1_500);
  else if (uniqueDetailPage) scope = normalizedPage;
  else return null;
  if (/대기신청|대기접수|대기자모집|대기예약/.test(scope)) return "대기접수";
  if (/정원마감|정원초과|모집마감|접수마감|신청마감|접수종료|모집종료/.test(scope)) return "정원마감";
  if (/접수예정|모집예정|신청예정|접수전/.test(scope)) return "접수예정";
  if (/접수중|신청가능|예약가능|모집중/.test(scope)) return "접수중";
  return null;
}

const statusFor = {
  접수중: "신청 가능", 접수예정: "접수 예정", 대기접수: "대기 신청",
  정원마감: "정원 마감", 접수마감: "접수 마감", 전화확인: "전화 확인",
};
const availabilityForStatus = {
  "신청 가능": "접수중", "접수 예정": "접수예정", "대기 신청": "대기접수",
  "정원 마감": "정원마감", "접수 마감": "접수마감", "전화 확인": "전화확인",
};
const safeNextStates = {
  접수예정: new Set(["접수중", "대기접수", "정원마감", "접수마감"]),
  접수중: new Set(["대기접수", "정원마감", "접수마감"]),
  대기접수: new Set(["정원마감", "접수마감"]),
};

const genericLabels = /^(더보기|바로가기|상세보기|신청|예약|예약하기|추첨신청|접수중|접수예정|접수마감|대기접수|마감|목록|이전|다음|처음|마지막|홈|전체|교육|강좌|프로그램|공지사항|새소식|검색)$/;
const navigationNoise = /로그인|회원가입|사이트맵|개인정보|저작권|오시는길|조직도|직원|전화번호|민원|보도자료|채용|입찰|공고|메뉴|페이스북|인스타그램|유튜브|블로그/;
const excludedAudience = /영유아|유아|어린이|초등|중학생|고등학생|청소년|청년|키즈|아동|입시|진로적성|학부모와|부모동반|공동육아|저학년|고학년/;
const excludedService = /지원사업|예방접종|감면혜택|생필품|치료비|응시료|공간\s*이용|시설\s*예약|대관/;
const educationWords = /교육|강좌|강의|교실|특강|아카데미|배움|학습|수업|프로그램|문화학교|문해|스마트폰|컴퓨터|요가|체조|미술|음악|글쓰기|외국어|인문|정원|건강|운동|자격/;
const allowedCourseUrl = /webEduDetail|bookingOnlineRcepDetail|lectureDetail|lecture_view|\/lecture\/longlearn\/view|selectDongdaemunUserCourseView|InfoView|happyStudy\/user(?:view|detail)|\/edus\/view|selectReservView/i;
const idParamWords = /(?:^|[?&])(lectureIdx|lecture_idx|lctreRcritKey|clIdx|eli_lect_key|eduMngNo|progrmNo|rsv_svc_id|id)=/i;

function canonicalUrl(href, base) {
  try {
    const url = new URL(decodeEntities(href), base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "fbclid"].forEach((key) => url.searchParams.delete(key));
    return url.href;
  } catch { return null; }
}

function stableCourseId(url, district = "") {
  try {
    const parsed = new URL(url);
    const idKeys = ["lectureIdx", "lecture_idx", "lctreRcritKey", "clIdx", "eli_lect_key", "eduMngNo", "progrmNo", "rsv_svc_id", "id"];
    for (const key of idKeys) {
      const value = parsed.searchParams.get(key);
      if (value) return `${district}|${parsed.hostname.replace(/^www\./, "")}|${key.toLowerCase()}=${value}`;
    }
    return `${district}|${canonicalUrl(url, url)}`;
  } catch { return `${district}|${url}`; }
}

function extractAnchors(html, baseUrl) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) continue;
    const url = canonicalUrl(href, baseUrl);
    const title = courseTitle(match[2]);
    if (url && title) anchors.push({ title, url });
  }
  return anchors;
}

function isLikelyCourseLink(candidate, listUrl, listText) {
  const { title, url } = candidate;
  if (title.length < 4 || title.length > 120 || !/[가-힣]/.test(title)) return false;
  if (genericLabels.test(title) || navigationNoise.test(title) || excludedAudience.test(title) || excludedService.test(title)) return false;
  let sameHost = false;
  try { sameHost = new URL(url).hostname.replace(/^www\./, "") === new URL(listUrl).hostname.replace(/^www\./, ""); } catch {}
  if (!sameHost) return false;
  const strongDetail = allowedCourseUrl.test(url) && (idParamWords.test(url) || /detail|view/i.test(new URL(url).pathname));
  const educationalTitle = educationWords.test(title);
  const educationalPage = educationWords.test(listText.slice(0, 20_000));
  return strongDetail && (educationalTitle || educationalPage);
}

function inferCategory(title) {
  if (/스마트폰|컴퓨터|디지털|AI|인공지능|엑셀|한글|PPT|키오스크|코딩/.test(title)) return "디지털";
  if (/영어|일본어|중국어|외국어/.test(title)) return "외국어";
  if (/그림|미술|드로잉|공예|도예|캘리|사진/.test(title)) return "미술";
  if (/음악|노래|악기|합창|우쿨렐레|하모니카/.test(title)) return "음악";
  if (/운동|체조|요가|필라테스|댄스|건강|걷기|탁구/.test(title)) return "건강";
  if (/정원|원예|식물|숲/.test(title)) return "정원";
  if (/글쓰기|문해|필사/.test(title)) return "글쓰기";
  return "인문";
}

function inferSchedule(text) {
  const match = text.match(/(?:교육기간|운영기간|강의기간|수강기간|일\s*시|교육일시)\s*[:：]?\s*([^|]{4,70})/i);
  return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 70) : "일정은 공식 페이지 확인";
}

function inferCost(text) {
  if (/수강료\s*[:：]?\s*무료|참가비\s*[:：]?\s*무료|교육비\s*[:：]?\s*무료|무료\s*(교육|강좌|수강)/.test(text)) return "무료";
  const match = text.match(/(?:수강료|참가비|교육비)\s*[:：]?\s*([0-9,]+\s*원)/);
  return match?.[1]?.replace(/\s+/g, "") ?? "공식 페이지 확인";
}

const urlCounts = new Map();
for (const program of programs) urlCounts.set(program.url, (urlCounts.get(program.url) ?? 0) + 1);
const statusUrls = [...urlCounts.keys()];
const sourcePairs = discoverySources.flatMap((source) => source.urls.map((url) => ({ ...source, url })));
const allSeedResults = await fetchMany([...statusUrls, ...sourcePairs.map((source) => source.url)], 4);
const statusResults = allSeedResults;

let checked = 0;
let failed = 0;
let changed = 0;
const updatedPrograms = programs.map((program) => {
  const result = statusResults.get(program.url);
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
  const currentAvailability = program.availability ?? availabilityForStatus[program.status];
  const transitionIsSafe = inferred && inferred !== currentAvailability && safeNextStates[currentAvailability]?.has(inferred);
  if (transitionIsSafe) {
    next.availability = inferred;
    next.status = statusFor[inferred] ?? program.status;
    next.change = "상태변경";
    changed += 1;
  }
  return next;
});

const discoveryResults = allSeedResults;
const rawCandidates = [];
let discoverySourcesChecked = 0;
let discoverySourcesFailed = 0;
for (const source of sourcePairs) {
  const result = discoveryResults.get(source.url);
  if (!result?.ok) { discoverySourcesFailed += 1; continue; }
  discoverySourcesChecked += 1;
  for (const candidate of extractAnchors(result.html, result.finalUrl ?? source.url)) {
    if (isLikelyCourseLink(candidate, source.url, result.text)) rawCandidates.push({ ...candidate, district: source.district, institution: source.institution });
  }
}

const existingKeys = new Set(updatedPrograms.map((program) => `${program.district}|${compact(program.title)}`));
const existingUrls = new Set(updatedPrograms.map((program) => canonicalUrl(program.url, program.url)).filter(Boolean));
const existingIdentities = new Set(updatedPrograms.map((program) => stableCourseId(program.url, program.district)));
const candidateMap = new Map();
for (const candidate of rawCandidates) {
  const key = `${candidate.district}|${compact(candidate.title)}`;
  const identity = stableCourseId(candidate.url, candidate.district);
  if (existingKeys.has(key) || existingUrls.has(candidate.url) || existingIdentities.has(identity)) continue;
  const previous = candidateMap.get(identity);
  if (!previous || candidate.title.length > previous.title.length) candidateMap.set(identity, candidate);
}

const candidates = [...candidateMap.values()].filter((candidate) => !existingKeys.has(`${candidate.district}|${compact(candidate.title)}`)).slice(0, 120);
const candidateResults = await fetchMany(candidates.map((candidate) => candidate.url), 4);
const discoveredPrograms = [];
for (const candidate of candidates) {
  const result = candidateResults.get(candidate.url);
  if (!result?.ok) continue;
  const titleKey = compact(candidate.title);
  const pageKey = compact(result.text.slice(0, 80_000));
  if (!pageKey.includes(titleKey) && !educationWords.test(result.text.slice(0, 30_000))) continue;
  const titlePosition = pageKey.indexOf(titleKey);
  const titleScope = titlePosition >= 0 ? result.text.slice(Math.max(0, titlePosition - 500), titlePosition + candidate.title.length + 2_000) : result.text.slice(0, 20_000);
  if (excludedAudience.test(titleScope) || excludedService.test(candidate.title)) continue;
  const availability = inferAvailability(result.text, candidate, true);
  if (!availability || !new Set(["접수중", "접수예정", "대기접수"]).has(availability)) continue;
  discoveredPrograms.push({
    district: candidate.district,
    institution: candidate.institution,
    title: candidate.title,
    category: inferCategory(candidate.title),
    schedule: inferSchedule(result.text),
    status: statusFor[availability] ?? "전화 확인",
    cost: inferCost(result.text),
    note: "공식 목록에서 자동 발견 · 대상 연령과 세부 일정은 신청 전 확인",
    url: result.finalUrl ?? candidate.url,
    startPhase: "확인 필요",
    availability,
    change: "신규",
    discoveredAt: now.toISOString(),
    lastCheckedAt: now.toISOString(),
    lastSuccessfulAt: now.toISOString(),
    sourceStatus: "확인됨",
    verified: shortDate,
  });
}

const allPrograms = [...discoveredPrograms, ...updatedPrograms];
const nextDataset = {
  ...dataset,
  schemaVersion: 2,
  collectedAt: kstDate,
  collectedAtIso: now.toISOString(),
  sourceCount: new Set([...statusUrls, ...sourcePairs.map((source) => source.url)]).size,
  discovery: {
    enabled: true,
    sourcePages: sourcePairs.length,
    checked: discoverySourcesChecked,
    failed: discoverySourcesFailed,
    candidates: candidateMap.size,
    failedSources: sourcePairs.filter((source) => !discoveryResults.get(source.url)?.ok).map((source) => ({
      district: source.district,
      institution: source.institution,
      url: source.url,
      error: discoveryResults.get(source.url)?.error ?? "응답 없음",
    })),
  },
  stats: {
    programs: allPrograms.length, checked, failed, changed,
    discovered: discoveredPrograms.length,
  },
  programs: allPrograms,
};

if (!dryRun) await writeFile(dataPath, `${JSON.stringify(nextDataset, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...nextDataset.stats, discovery: nextDataset.discovery, dryRun }));
if (dryRun && discoveredPrograms.length) {
  console.log(discoveredPrograms.slice(0, 30).map(({ district, institution, title, url }) => ({ district, institution, title, url })));
}
