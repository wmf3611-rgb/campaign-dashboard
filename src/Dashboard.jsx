// ============================================================
// campaign-dashboard v1.1 (2026-06-22)
// 변경사항: 전체예산 룰 차트에 마지노선(판단 기준 데이터) 표기 추가
// ============================================================
import React, { useState, useMemo, useCallback, useEffect } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Upload, AlertTriangle, TrendingUp, TrendingDown, Minus,
  CheckCircle2, Info, ChevronDown, ChevronUp,
  DollarSign, Target, AlertOctagon, RefreshCw,
} from "lucide-react";

const IAP_RATE = 0.7;
const AD_RATE = 1.0;
const TARGET_ROAS = 0.40;
const BUDGET_ROUND_UNIT = 50;
const MIN_CAMPAIGN_COST_FOR_POOL = 50;
const TERMINATION_THRESHOLD = 0.10;

const ZONES = [
  { key: "big_over", label: "큰 초과", min: 0.44, max: Infinity, rate: 0.15, color: "#1E7B45" },
  { key: "mid_over", label: "소폭 초과", min: 0.40, max: 0.44, rateFn: (v) => 0.05 + ((v - 0.40) / 0.04) * 0.05, color: "#2E9E5B" },
  { key: "ok", label: "적정", min: 0.36, max: 0.40, rate: 0, color: "#B7791F" },
  { key: "mid_under", label: "중간 미달", min: 0.30, max: 0.36, rate: -0.10, color: "#C9622B" },
  { key: "big_under", label: "심각 미달", min: -Infinity, max: 0.30, rate: -0.20, color: "#A4262C" },
];

function getZone(roas) {
  if (roas == null || isNaN(roas)) return null;
  for (const z of ZONES) {
    if (roas >= z.min && roas < z.max) {
      const rate = z.rateFn ? z.rateFn(roas) : z.rate;
      return { ...z, rate };
    }
  }
  return ZONES[ZONES.length - 1];
}

function stabilityMultiplier(deltaPp) {
  if (deltaPp == null || isNaN(deltaPp)) return { mult: 1.0, label: "기준없음" };
  const d = Math.abs(deltaPp) * 100;
  if (d <= 5) return { mult: 1.0, label: "안정" };
  if (d <= 10) return { mult: 0.6, label: "흔들림" };
  return { mult: 0.3, label: "급변" };
}

function roundToUnit(amount, unit) {
  return Math.round(amount / unit) * unit;
}

function fmtPct(v, digits = 1) {
  if (v == null || isNaN(v)) return "-";
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtPp(v, digits = 1) {
  if (v == null || isNaN(v)) return "-";
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(digits)}%p`;
}
function fmtMoney(v) {
  if (v == null || isNaN(v)) return "-";
  return `$${Math.round(v).toLocaleString()}`;
}
function fmtMoneySigned(v) {
  if (v == null || isNaN(v)) return "-";
  const s = v >= 0 ? "+" : "";
  return `${s}$${Math.round(v).toLocaleString()}`;
}

const COLUMN_PATTERNS = {
  date: [/^date$/i, /날짜/, /^day$/i],
  campaign: [/^campaign/i, /캠페인/],
  cost: [/^cost$/i, /비용/, /spend/i],
  installs: [/install/i, /설치/],
  iap_d7: [/revenue.*7.*purchase/i, /7.*day.*purchase/i, /d7.*iap/i, /d7.*purchase/i],
  adview_d7: [/revenue.*7.*ad_?view/i, /7.*day.*ad_?view/i, /d7.*ad_?view/i, /d7.*ad/i],
  iap_d14: [/revenue.*14.*purchase/i, /14.*day.*purchase/i, /d14.*iap/i, /d14.*purchase/i],
  adview_d14: [/revenue.*14.*ad_?view/i, /14.*day.*ad_?view/i, /d14.*ad_?view/i, /d14.*ad/i],
};

function autoDetectColumns(headers) {
  const mapping = {};
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    let found = null;
    for (const pattern of patterns) {
      found = headers.find((h) => pattern.test(h));
      if (found) break;
    }
    mapping[field] = found || "";
  }
  return mapping;
}

const FIELD_LABELS = {
  date: "날짜 (필수)",
  campaign: "캠페인명 (필수, 빈값=오가닉)",
  cost: "비용/Cost (필수)",
  installs: "설치수 (선택)",
  iap_d7: "D7 IAP 매출 (필수)",
  adview_d7: "D7 광고 매출 (필수)",
  iap_d14: "D14 IAP 매출 (선택, 종료판단용)",
  adview_d14: "D14 광고 매출 (선택, 종료판단용)",
};
const REQUIRED_FIELDS = ["date", "campaign", "cost", "iap_d7", "adview_d7"];

function buildDateRange(minDate, maxDate) {
  const dates = [];
  let cur = new Date(minDate);
  const end = new Date(maxDate);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function rollingMean(seriesMap, dateKeys, windowSize) {
  const result = {};
  const values = dateKeys.map((d) => seriesMap[d]);
  for (let i = 0; i < dateKeys.length; i++) {
    if (i < windowSize - 1) {
      result[dateKeys[i]] = null;
      continue;
    }
    const window = values.slice(i - windowSize + 1, i + 1);
    if (window.some((v) => v == null || isNaN(v))) {
      result[dateKeys[i]] = null;
    } else {
      result[dateKeys[i]] = window.reduce((a, b) => a + b, 0) / windowSize;
    }
  }
  return result;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function getWeekday(dateStr) {
  return new Date(dateStr).getDay();
}

const STORAGE_KEYS = {
  budgets: "dashboard:campaign-budgets",
  upload: "dashboard:last-upload",
  decisionDate: "dashboard:decision-date",
};

async function loadFromStorage(key) {
  try {
    const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.value ? JSON.parse(data.value) : null;
  } catch (e) {
    return null;
  }
}

async function saveToStorage(key, value) {
  try {
    const res = await fetch("/api/storage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: JSON.stringify(value) }),
    });
    return res.ok;
  } catch (e) {
    console.error("저장 실패:", key, e);
    return false;
  }
}

async function deleteFromStorage(key) {
  try {
    await fetch(`/api/storage?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  } catch (e) {
    // 키가 원래 없었을 수도 있음, 무시
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export default function Dashboard() {
  const [rawRows, setRawRows] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [fileName, setFileName] = useState("");
  const [campaignBudgets, setCampaignBudgets] = useState({});
  const [decisionDateOverride, setDecisionDateOverride] = useState("");
  const [expandedSections, setExpandedSections] = useState({ insights: true });

  const [isLoadingShared, setIsLoadingShared] = useState(true);
  const [syncStatus, setSyncStatus] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [savedBudgets, savedUpload, savedDecisionDate] = await Promise.all([
        loadFromStorage(STORAGE_KEYS.budgets),
        loadFromStorage(STORAGE_KEYS.upload),
        loadFromStorage(STORAGE_KEYS.decisionDate),
      ]);
      if (cancelled) return;

      if (savedBudgets) setCampaignBudgets(savedBudgets);
      if (savedDecisionDate?.value) setDecisionDateOverride(savedDecisionDate.value);
      if (savedUpload?.rawRows && savedUpload?.mapping) {
        setHeaders(savedUpload.headers || []);
        setMapping(savedUpload.mapping);
        setRawRows(savedUpload.rawRows);
        setFileName(savedUpload.fileName || "");
        setMappingConfirmed(true);
        setLastSyncedAt(savedUpload.uploadedAt || null);
      }
      setIsLoadingShared(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const debouncedSaveBudgets = useMemo(
    () => debounce(async (budgets) => {
      setSyncStatus("saving");
      const ok = await saveToStorage(STORAGE_KEYS.budgets, budgets);
      setSyncStatus(ok ? "saved" : "error");
      if (ok) setLastSyncedAt(new Date().toISOString());
    }, 600),
    []
  );

  useEffect(() => {
    if (isLoadingShared) return;
    if (Object.keys(campaignBudgets).length === 0) return;
    debouncedSaveBudgets(campaignBudgets);
  }, [campaignBudgets, isLoadingShared, debouncedSaveBudgets]);

  useEffect(() => {
    if (isLoadingShared) return;
    if (!decisionDateOverride) return;
    saveToStorage(STORAGE_KEYS.decisionDate, { value: decisionDateOverride });
  }, [decisionDateOverride, isLoadingShared]);

  const handleFile = useCallback((file) => {
    setParseError(null);
    setFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (results) => {
        if (!results.data || results.data.length === 0) {
          setParseError("파일에서 데이터를 읽을 수 없습니다. CSV 형식을 확인해주세요.");
          return;
        }
        const hdrs = results.meta.fields || Object.keys(results.data[0]);
        setHeaders(hdrs);
        setMapping(autoDetectColumns(hdrs));
        setRawRows(results.data);
        setMappingConfirmed(false);
      },
      error: (err) => {
        setParseError(`파일 읽기 오류: ${err.message}`);
      },
    });
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleConfirmMapping = useCallback(async () => {
    setMappingConfirmed(true);
    setSyncStatus("saving");
    const ok = await saveToStorage(STORAGE_KEYS.upload, {
      fileName, headers, mapping, rawRows,
      uploadedAt: new Date().toISOString(),
    });
    setSyncStatus(ok ? "saved" : "error");
    if (ok) setLastSyncedAt(new Date().toISOString());
  }, [fileName, headers, mapping, rawRows]);

  const handleResetFile = useCallback(async () => {
    setRawRows(null); setMapping(null); setMappingConfirmed(false); setHeaders([]);
    await deleteFromStorage(STORAGE_KEYS.upload);
  }, []);

  const handleResetAll = useCallback(async () => {
    const confirmed = window.confirm("팀 전체가 공유 중인 데이터(업로드 파일 + 입력한 모든 예산)가 삭제됩니다. 계속할까요?");
    if (!confirmed) return;
    setRawRows(null); setMapping(null); setMappingConfirmed(false); setHeaders([]);
    setCampaignBudgets({});
    await Promise.all([
      deleteFromStorage(STORAGE_KEYS.upload),
      deleteFromStorage(STORAGE_KEYS.budgets),
      deleteFromStorage(STORAGE_KEYS.decisionDate),
    ]);
  }, []);

  const parsedData = useMemo(() => {
    if (!rawRows || !mapping || !mappingConfirmed) return null;
    const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
    if (missing.length > 0) return null;

    const rows = [];
    for (const r of rawRows) {
      const dateRaw = r[mapping.date];
      if (!dateRaw) continue;
      const d = new Date(dateRaw);
      if (isNaN(d.getTime())) continue;
      const dateStr = d.toISOString().slice(0, 10);

      const campaign = mapping.campaign ? (r[mapping.campaign] || "").trim() : "";
      const cost = parseFloat(r[mapping.cost]) || 0;
      const iap7 = parseFloat(r[mapping.iap_d7]) || 0;
      const ad7 = parseFloat(r[mapping.adview_d7]) || 0;
      const iap14 = mapping.iap_d14 ? (parseFloat(r[mapping.iap_d14]) || null) : null;
      const ad14 = mapping.adview_d14 ? (parseFloat(r[mapping.adview_d14]) || null) : null;
      const installs = mapping.installs ? (parseFloat(r[mapping.installs]) || 0) : null;

      const rev7 = iap7 * IAP_RATE + ad7 * AD_RATE;
      const rev14 = (iap14 != null && ad14 != null) ? (iap14 * IAP_RATE + ad14 * AD_RATE) : null;

      rows.push({
        date: dateStr,
        campaign: campaign || null,
        cost,
        rev7,
        rev14,
        roas7: cost > 0 ? rev7 / cost : null,
        roas14: cost > 0 && rev14 != null ? rev14 / cost : null,
        installs,
      });
    }
    if (rows.length === 0) return null;
    return rows;
  }, [rawRows, mapping, mappingConfirmed]);

  const campaignList = useMemo(() => {
    if (!parsedData) return [];
    const set = new Set();
    parsedData.forEach((r) => { if (r.campaign) set.add(r.campaign); });
    return Array.from(set).sort();
  }, [parsedData]);

  const dateInfo = useMemo(() => {
    if (!parsedData) return null;
    const dates = parsedData.map((r) => r.date);
    const minDate = dates.reduce((a, b) => (a < b ? a : b));
    const maxDate = dates.reduce((a, b) => (a > b ? a : b));
    return { minDate, maxDate, allDates: buildDateRange(minDate, maxDate) };
  }, [parsedData]);

  const decisionDate = useMemo(() => {
    if (!dateInfo) return null;
    if (decisionDateOverride) return decisionDateOverride;
    let cur = new Date(dateInfo.maxDate);
    for (let i = 0; i < 7; i++) {
      const wd = cur.getDay();
      if (wd === 1 || wd === 4) {
        return cur.toISOString().slice(0, 10);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return dateInfo.maxDate;
  }, [dateInfo, decisionDateOverride]);

  const markDate7 = decisionDate ? addDays(decisionDate, -8) : null;
  const markDate14 = decisionDate ? addDays(decisionDate, -8) : null;

  const blendedAnalysis = useMemo(() => {
    if (!parsedData || !dateInfo) return null;

    const paidByDate = {};
    const organicByDate = {};
    parsedData.forEach((r) => {
      const bucket = r.campaign ? paidByDate : organicByDate;
      if (!bucket[r.date]) bucket[r.date] = { cost: 0, rev7: 0 };
      bucket[r.date].cost += r.cost;
      bucket[r.date].rev7 += r.rev7;
    });

    const roasSeries = {};
    dateInfo.allDates.forEach((d) => {
      const paid = paidByDate[d];
      const organicRev = organicByDate[d]?.rev7 || 0;
      if (paid && paid.cost > 0) {
        roasSeries[d] = (paid.rev7 + organicRev) / paid.cost;
      } else {
        roasSeries[d] = null;
      }
    });

    const ma7 = rollingMean(roasSeries, dateInfo.allDates, 7);

    const decisionPoints = dateInfo.allDates.filter((d) => {
      const wd = getWeekday(d);
      return wd === 1 || wd === 4;
    });

    const chartData = dateInfo.allDates
      .filter((d) => ma7[d] != null)
      .map((d) => ({ date: d.slice(5), value: ma7[d] }));

    return { paidByDate, organicByDate, roasSeries, ma7, decisionPoints, chartData };
  }, [parsedData, dateInfo]);

  const rule1Result = useMemo(() => {
    if (!blendedAnalysis || !markDate7) return null;
    const currentMa = blendedAnalysis.ma7[markDate7];
    if (currentMa == null) return { insufficient: true };

    const dp = blendedAnalysis.decisionPoints.filter((d) => d < decisionDate);
    const prevDecision = dp.length > 0 ? dp[dp.length - 1] : null;
    const prevMark = prevDecision ? addDays(prevDecision, -8) : null;
    const prevMa = prevMark ? blendedAnalysis.ma7[prevMark] : null;

    const zone = getZone(currentMa);
    const deltaPp = prevMa != null ? currentMa - prevMa : null;
    const stability = stabilityMultiplier(deltaPp);
    const finalRate = zone.rate * stability.mult;

    return {
      insufficient: false,
      currentMa, prevMa, deltaPp, zone, stability, finalRate,
      markDate7, prevMark,
    };
  }, [blendedAnalysis, markDate7, decisionDate]);

  const currentTotalBudget = useMemo(() => {
    return campaignList.reduce((sum, c) => sum + (parseFloat(campaignBudgets[c]) || 0), 0);
  }, [campaignList, campaignBudgets]);

  const rule1Budget = useMemo(() => {
    if (!rule1Result || rule1Result.insufficient) return null;
    const raw = currentTotalBudget * (1 + rule1Result.finalRate);
    const rounded = roundToUnit(raw, BUDGET_ROUND_UNIT);
    return { raw, rounded, delta: rounded - currentTotalBudget };
  }, [rule1Result, currentTotalBudget]);

  const campaignAnalysis = useMemo(() => {
    if (!parsedData || !dateInfo || !markDate7) return null;

    const perCampaign = {};
    campaignList.forEach((c) => { perCampaign[c] = {}; });
    parsedData.forEach((r) => {
      if (!r.campaign) return;
      if (!perCampaign[r.campaign][r.date]) {
        perCampaign[r.campaign][r.date] = { cost: 0, rev7: 0, rev14: 0, has14: false };
      }
      perCampaign[r.campaign][r.date].cost += r.cost;
      perCampaign[r.campaign][r.date].rev7 += r.rev7;
      if (r.rev14 != null) {
        perCampaign[r.campaign][r.date].rev14 += r.rev14;
        perCampaign[r.campaign][r.date].has14 = true;
      }
    });

    const avgDailyCost = {};
    campaignList.forEach((c) => {
      const entries = Object.values(perCampaign[c]);
      const totalCost = entries.reduce((s, e) => s + e.cost, 0);
      avgDailyCost[c] = entries.length > 0 ? totalCost / entries.length : 0;
    });

    const eligibleCampaigns = campaignList.filter((c) => avgDailyCost[c] > MIN_CAMPAIGN_COST_FOR_POOL);

    const campaignMa = {};
    eligibleCampaigns.forEach((c) => {
      const dates = dateInfo.allDates;
      const roasSeries7 = {};
      const roasSeries14 = {};
      dates.forEach((d) => {
        const entry = perCampaign[c][d];
        roasSeries7[d] = entry && entry.cost > 0 ? entry.rev7 / entry.cost : null;
        roasSeries14[d] = entry && entry.cost > 0 && entry.has14 ? entry.rev14 / entry.cost : null;
      });
      const ma7map = rollingMean(roasSeries7, dates, 7);
      const ma14map = rollingMean(roasSeries14, dates, 14);
      campaignMa[c] = {
        ma7: ma7map[markDate7],
        ma14: ma14map[markDate14],
        hasData: ma7map[markDate7] != null,
      };
    });

    const paidTotalSeries = {};
    dateInfo.allDates.forEach((d) => {
      let cost = 0, rev = 0;
      eligibleCampaigns.forEach((c) => {
        const entry = perCampaign[c][d];
        if (entry) { cost += entry.cost; rev += entry.rev7; }
      });
      paidTotalSeries[d] = cost > 0 ? rev / cost : null;
    });
    const paidTotalMa7 = rollingMean(paidTotalSeries, dateInfo.allDates, 7);
    const benchmark = paidTotalMa7[markDate7];

    const campaigns = eligibleCampaigns
      .filter((c) => campaignMa[c].hasData)
      .map((c) => {
        const ma7 = campaignMa[c].ma7;
        const ma14 = campaignMa[c].ma14;
        const group = benchmark != null ? (ma7 >= benchmark ? "above" : "below") : null;
        const gap = benchmark != null ? ma7 - benchmark : null;
        const terminationFlag = ma14 != null && ma14 <= TERMINATION_THRESHOLD;
        return {
          name: c,
          ma7, ma14, group, gap, terminationFlag,
          currentBudget: parseFloat(campaignBudgets[c]) || 0,
          avgDailyCost: avgDailyCost[c],
        };
      });

    const excludedCampaigns = campaignList.filter((c) => !eligibleCampaigns.includes(c) || !campaignMa[c]?.hasData);

    return { campaigns, benchmark, excludedCampaigns, eligibleCampaigns };
  }, [parsedData, dateInfo, markDate7, markDate14, campaignList, campaignBudgets]);

  const rule2Allocation = useMemo(() => {
    if (!campaignAnalysis || !rule1Budget) return null;
    const { campaigns } = campaignAnalysis;
    const totalAdjust = rule1Budget.delta;

    const result = {};
    campaigns.forEach((c) => { result[c.name] = { allocated: 0, newBudget: c.currentBudget }; });

    if (totalAdjust === 0) {
      campaigns.forEach((c) => { result[c.name].newBudget = c.currentBudget; });
      return { totalAdjust, perCampaign: result, mode: "none" };
    }

    const mode = totalAdjust > 0 ? "increase" : "decrease";
    const targetGroup = campaigns.filter((c) => (mode === "increase" ? c.group === "above" : c.group === "below"));
    const totalGap = targetGroup.reduce((s, c) => s + Math.abs(c.gap || 0), 0);

    campaigns.forEach((c) => {
      if (targetGroup.includes(c) && totalGap > 0) {
        const share = Math.abs(c.gap) / totalGap;
        const rawAlloc = totalAdjust * share;
        const roundedAlloc = roundToUnit(rawAlloc, BUDGET_ROUND_UNIT);
        result[c.name] = {
          allocated: roundedAlloc,
          newBudget: c.currentBudget + roundedAlloc,
          share,
        };
      } else {
        result[c.name] = { allocated: 0, newBudget: c.currentBudget, share: 0 };
      }
    });

    return { totalAdjust, perCampaign: result, mode, targetGroup: targetGroup.map(c => c.name) };
  }, [campaignAnalysis, rule1Budget]);

  const insights = useMemo(() => {
    if (!rule1Result || rule1Result.insufficient || !campaignAnalysis) return [];
    const list = [];

    if (rule1Result.deltaPp != null) {
      if (Math.abs(rule1Result.deltaPp) > 0.10) {
        list.push({
          type: "warn",
          text: `전체 Blended ROAS가 직전 판단 대비 ${fmtPp(rule1Result.deltaPp)}로 크게 변동했습니다. 안정성 배수(×${rule1Result.stability.mult})가 적용되어 기본 조정폭이 약화되었습니다.`,
        });
      } else if (rule1Result.deltaPp > 0.03) {
        list.push({ type: "good", text: `전체 ROAS가 직전 대비 ${fmtPp(rule1Result.deltaPp)} 개선되는 추세입니다.` });
      } else if (rule1Result.deltaPp < -0.03) {
        list.push({ type: "warn", text: `전체 ROAS가 직전 대비 ${fmtPp(rule1Result.deltaPp)} 하락하는 추세입니다.` });
      }
    }

    const hasAnyD14 = campaignAnalysis.campaigns.some((c) => c.ma14 != null);
    if (!hasAnyD14) {
      list.push({
        type: "info",
        text: "업로드된 파일에 D14 매출 데이터가 없어 종료 검토 트리거(14일 이동평균 기준)를 계산할 수 없습니다. 7일 이동평균 ROAS로 참고만 하세요.",
      });
    }

    const terminationCandidates = campaignAnalysis.campaigns.filter((c) => c.terminationFlag);
    if (terminationCandidates.length > 0) {
      terminationCandidates.forEach((c) => {
        list.push({
          type: "danger",
          text: `${c.name} — 14일 이동평균 D7 ROAS ${fmtPct(c.ma14)}로 종료 임계값(${fmtPct(TERMINATION_THRESHOLD, 0)}) 이하입니다. 종료 검토가 필요합니다.`,
        });
      });
    }

    const sorted = [...campaignAnalysis.campaigns].filter(c => c.gap != null).sort((a, b) => b.gap - a.gap);
    if (sorted.length > 0 && sorted[0].gap > 0.15) {
      list.push({
        type: "info",
        text: `${sorted[0].name}가 기준선 대비 ${fmtPp(sorted[0].gap)}로 압도적 우위에 있습니다. 다음 증액 사이클에서 배분 비중이 클 것으로 예상됩니다(현재 예산 ${fmtMoney(sorted[0].currentBudget)}).`,
      });
    }
    const worst = sorted[sorted.length - 1];
    if (worst && worst.gap < -0.10 && !worst.terminationFlag) {
      list.push({
        type: "warn",
        text: `${worst.name}가 기준선 대비 ${fmtPp(worst.gap)}로 가장 부진합니다. 14일 기준으로는 아직 종료선 위이나, 추세를 주시할 필요가 있습니다.`,
      });
    }

    if (campaignAnalysis.excludedCampaigns.length > 0) {
      list.push({
        type: "info",
        text: `${campaignAnalysis.excludedCampaigns.join(", ")} — 일평균 비용 $${MIN_CAMPAIGN_COST_FOR_POOL} 이하 또는 데이터 부족으로 이번 판단에서 제외되었습니다.`,
      });
    }

    return list;
  }, [rule1Result, campaignAnalysis]);

  const toggleSection = (key) => setExpandedSections((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div style={{
      fontFamily: "'IBM Plex Sans', 'Inter', system-ui, sans-serif",
      background: "#0F1115",
      color: "#E8E9ED",
      minHeight: "100%",
      padding: "0",
    }}>
      <style>{`
        * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #1A1D24; }
        ::-webkit-scrollbar-thumb { background: #353A45; border-radius: 4px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; }
      `}</style>

      <Header fileName={fileName} parsedData={parsedData} dateInfo={dateInfo} decisionDate={decisionDate}
        onDecisionDateChange={setDecisionDateOverride} syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} />

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 24px 64px" }}>
        {isLoadingShared && (
          <div style={{ marginTop: 60, textAlign: "center", color: "#6B7280", fontSize: 13 }}>
            팀 공유 데이터를 불러오는 중...
          </div>
        )}

        {!isLoadingShared && !parsedData && (
          <UploadZone onDrop={onDrop} onFile={handleFile} parseError={parseError} />
        )}

        {rawRows && mapping && !mappingConfirmed && (
          <ColumnMappingPanel
            headers={headers} mapping={mapping} setMapping={setMapping}
            onConfirm={handleConfirmMapping}
            sampleRow={rawRows[0]}
          />
        )}

        {parsedData && (
          <>
            <BudgetInputPanel
              campaignList={campaignList}
              campaignBudgets={campaignBudgets}
              setCampaignBudgets={setCampaignBudgets}
              currentTotalBudget={currentTotalBudget}
            />

            <Rule1Panel
              rule1Result={rule1Result}
              rule1Budget={rule1Budget}
              currentTotalBudget={currentTotalBudget}
              blendedAnalysis={blendedAnalysis}
              decisionDate={decisionDate}
              markDate7={markDate7}
            />

            <Rule2Panel
              campaignAnalysis={campaignAnalysis}
              rule2Allocation={rule2Allocation}
              rule1Result={rule1Result}
            />

            <InsightsPanel
              insights={insights}
              expanded={expandedSections.insights}
              onToggle={() => toggleSection("insights")}
            />

            <div style={{ textAlign: "center", marginTop: 32, display: "flex", justifyContent: "center", gap: 10 }}>
              <button onClick={handleResetFile} style={resetButtonStyle}>
                <RefreshCw size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
                새 파일 업로드
              </button>
              <button onClick={handleResetAll} style={{ ...resetButtonStyle, borderColor: "#4A2A2E", color: "#C9622B" }}>
                팀 공유 데이터 전체 초기화
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Header({ fileName, parsedData, dateInfo, decisionDate, onDecisionDateChange, syncStatus, lastSyncedAt }) {
  const syncLabel = syncStatus === "saving" ? "저장 중..."
    : syncStatus === "error" ? "저장 실패 (새로고침 시 사라질 수 있음)"
    : lastSyncedAt ? `팀 공유 데이터 · ${new Date(lastSyncedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 동기화`
    : null;
  const syncColor = syncStatus === "error" ? "#C9622B" : syncStatus === "saving" ? "#B7791F" : "#3D8B5F";

  return (
    <div style={{
      borderBottom: "1px solid #23262E",
      background: "linear-gradient(180deg, #14161B 0%, #0F1115 100%)",
      padding: "28px 24px 24px",
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: "0.12em", color: "#6B7280", textTransform: "uppercase", marginBottom: 6 }}>
              Performance Marketing · Rule Engine
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
              캠페인 지표 체크 &amp; 예산 제안
            </h1>
          </div>
          {parsedData && dateInfo && (
            <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 13, color: "#9499A6" }}>
              <span>{fileName}</span>
              <span style={{ color: "#353A45" }}>|</span>
              <span className="mono">{dateInfo.minDate} ~ {dateInfo.maxDate}</span>
            </div>
          )}
        </div>
        {parsedData && decisionDate && (
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
            <Target size={14} color="#5B8DEF" />
            <span style={{ color: "#9499A6" }}>판단 기준일 (월/목 사이클)</span>
            <input
              type="date"
              value={decisionDate}
              onChange={(e) => onDecisionDateChange(e.target.value)}
              className="mono"
              style={{
                background: "#1A1D24", border: "1px solid #2A2E38", borderRadius: 6,
                color: "#E8E9ED", padding: "5px 10px", fontSize: 13,
              }}
            />
            <span style={{ color: "#5D6270", fontSize: 12 }}>* 자동으로 데이터 마지막날 이후 가장 가까운 월/목으로 설정됨. 필요시 수정 가능</span>
            {syncLabel && (
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: syncColor, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: syncColor, display: "inline-block" }} />
                {syncLabel}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UploadZone({ onDrop, onFile, parseError }) {
  const [isDragOver, setIsDragOver] = useState(false);
  return (
    <div
      onDrop={(e) => { onDrop(e); setIsDragOver(false); }}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      style={{
        marginTop: 40,
        border: `2px dashed ${isDragOver ? "#5B8DEF" : "#2A2E38"}`,
        borderRadius: 12,
        padding: "64px 32px",
        textAlign: "center",
        background: isDragOver ? "#161A22" : "#13151A",
        transition: "all 0.15s",
      }}
    >
      <Upload size={32} color="#5B8DEF" style={{ marginBottom: 16 }} />
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        CSV 파일을 끌어다 놓거나 선택하세요
      </div>
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 24, lineHeight: 1.6 }}>
        AppsFlyer 등에서 추출한 날짜·캠페인별 성과 CSV (형식은 자유, 업로드 후 컬럼을 매칭합니다)
      </div>
      <label style={{
        display: "inline-block", background: "#5B8DEF", color: "#fff", padding: "10px 24px",
        borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer",
      }}>
        파일 선택
        <input type="file" accept=".csv" style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </label>
      {parseError && (
        <div style={{ marginTop: 20, color: "#E5894A", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <AlertTriangle size={14} /> {parseError}
        </div>
      )}
    </div>
  );
}

function ColumnMappingPanel({ headers, mapping, setMapping, onConfirm, sampleRow }) {
  const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  return (
    <div style={{ marginTop: 32, background: "#13151A", border: "1px solid #23262E", borderRadius: 12, padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Info size={16} color="#5B8DEF" />
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>컬럼 매칭 확인</h2>
      </div>
      <p style={{ fontSize: 13, color: "#9499A6", marginTop: 6, marginBottom: 20, lineHeight: 1.6 }}>
        파일의 컬럼명을 자동으로 추측했습니다. 맞는지 확인하고, 다르면 직접 선택해주세요.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {Object.entries(FIELD_LABELS).map(([field, label]) => (
          <div key={field}>
            <label style={{ fontSize: 12, color: "#9499A6", display: "block", marginBottom: 5 }}>
              {label}
            </label>
            <select
              value={mapping[field] || ""}
              onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
              style={{
                width: "100%", background: "#1A1D24",
                border: `1px solid ${REQUIRED_FIELDS.includes(field) && !mapping[field] ? "#A4262C" : "#2A2E38"}`,
                borderRadius: 6, color: "#E8E9ED", padding: "8px 10px", fontSize: 13,
              }}
            >
              <option value="">(사용 안 함)</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>

      {sampleRow && (
        <div style={{ marginTop: 18, fontSize: 12, color: "#6B7280" }}>
          예시 행: {Object.entries(mapping).filter(([,v]) => v).map(([k, v]) => (
            <span key={k} className="mono" style={{ marginRight: 14 }}>{k}="{String(sampleRow[v]).slice(0,20)}"</span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onConfirm}
          disabled={missing.length > 0}
          style={{
            background: missing.length > 0 ? "#2A2E38" : "#5B8DEF",
            color: missing.length > 0 ? "#5D6270" : "#fff",
            border: "none", borderRadius: 8, padding: "10px 22px", fontSize: 14, fontWeight: 600,
            cursor: missing.length > 0 ? "not-allowed" : "pointer",
          }}
        >
          이 매칭으로 진행
        </button>
        {missing.length > 0 && (
          <span style={{ fontSize: 12, color: "#C9622B" }}>
            필수 컬럼 미지정: {missing.map((f) => FIELD_LABELS[f]).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

function BudgetInputPanel({ campaignList, campaignBudgets, setCampaignBudgets, currentTotalBudget }) {
  const [open, setOpen] = useState(true);
  return (
    <SectionCard
      title="현재 운영 예산 입력"
      subtitle="각 캠페인에 실제로 설정된 일/주 예산을 입력하세요. 이 값이 모든 룰 계산의 '직전 예산' 기준이 됩니다. 팀원 누구나 입력하면 전체에 공유됩니다."
      icon={<DollarSign size={16} color="#5B8DEF" />}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      rightContent={<span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>합계 {fmtMoney(currentTotalBudget)}</span>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
        {campaignList.map((c) => (
          <div key={c} style={{ display: "flex", alignItems: "center", gap: 8, background: "#161A22", borderRadius: 8, padding: "8px 10px" }}>
            <span style={{ fontSize: 12, color: "#C5C8D1", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c}>
              {c}
            </span>
            <span style={{ color: "#5D6270", fontSize: 12 }}>$</span>
            <input
              type="number"
              value={campaignBudgets[c] ?? ""}
              onChange={(e) => setCampaignBudgets((b) => ({ ...b, [c]: e.target.value }))}
              placeholder="0"
              className="mono"
              style={{
                width: 80, background: "#0F1115", border: "1px solid #2A2E38", borderRadius: 5,
                color: "#E8E9ED", padding: "5px 8px", fontSize: 13, textAlign: "right",
              }}
            />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function Rule1Panel({ rule1Result, rule1Budget, currentTotalBudget, blendedAnalysis, decisionDate, markDate7 }) {
  const [open, setOpen] = useState(true);
  if (!rule1Result) return null;

  if (rule1Result.insufficient) {
    return (
      <SectionCard title="1. 전체 예산 룰" icon={<Target size={16} color="#5B8DEF" />} open={open} onToggle={() => setOpen(o=>!o)}>
        <EmptyNote text={`판단 기준일(마지노선 ${markDate7})에 7일 이동평균을 계산할 데이터가 부족합니다. 최소 7일 이상의 데이터가 필요합니다.`} />
      </SectionCard>
    );
  }

  const { currentMa, prevMa, deltaPp, zone, stability, finalRate } = rule1Result;
  const TrendIcon = deltaPp == null ? Minus : deltaPp > 0.01 ? TrendingUp : deltaPp < -0.01 ? TrendingDown : Minus;

  return (
    <SectionCard
      title="1. 전체 예산 룰"
      subtitle={`판단일 ${decisionDate} · 마지노선(성숙데이터) ${markDate7}`}
      icon={<Target size={16} color="#5B8DEF" />}
      open={open} onToggle={() => setOpen((o) => !o)}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <MetricBox label="Blended D7 ROAS (7일 이동평균)" value={fmtPct(currentMa)} accent={zone.color} />
          <MetricBox label="목표(40%) 대비" value={fmtPp(currentMa - TARGET_ROAS)} accent={currentMa >= TARGET_ROAS ? "#1E7B45" : "#A4262C"} />
          <MetricBox label="구간" value={zone.label} accent={zone.color} />
          <MetricBox
            label="직전 판단 대비"
            value={prevMa != null ? fmtPp(deltaPp) : "데이터없음"}
            icon={<TrendIcon size={14} />}
            accent={stability.label === "급변" ? "#C9622B" : stability.label === "흔들림" ? "#B7791F" : "#6B7280"}
          />
        </div>

        <div style={{ background: "#161A22", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label="기본 조정 (구간표)" value={fmtPct(zone.rate, 1)} />
          <Row label="안정성 배수" value={`×${stability.mult} (${stability.label})`} />
          <Row label="최종 조정률" value={fmtPct(finalRate, 2)} bold />
          <div style={{ height: 1, background: "#23262E", margin: "4px 0" }} />
          <Row label="현재 운영 예산" value={fmtMoney(currentTotalBudget)} />
          <Row label="계산값" value={fmtMoney(rule1Budget?.raw)} muted />
          <Row label={`제안 예산 ($${BUDGET_ROUND_UNIT} 단위 반올림)`} value={fmtMoney(rule1Budget?.rounded)} bold big />
          <Row label="변화액" value={fmtMoneySigned(rule1Budget?.delta)} accent={rule1Budget?.delta > 0 ? "#1E7B45" : rule1Budget?.delta < 0 ? "#A4262C" : "#6B7280"} />
        </div>
      </div>

      {blendedAnalysis?.chartData?.length > 1 && (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 11.5, color: "#6B7280", marginBottom: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span>Blended D7 ROAS — 7일 이동평균 추이</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5, color: "#9499A6" }}>
              <span style={{ width: 14, height: 0, borderTop: "1.5px dashed #C9622B", display: "inline-block" }} />
              마지노선(판단 기준 데이터) {markDate7}
            </span>
          </div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={blendedAnalysis.chartData} margin={{ top: 6, right: 12, bottom: 0, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#23262E" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={{ stroke: "#23262E" }} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `${Math.round(v * 100)}%`}
                  width={42}
                />
                <Tooltip
                  contentStyle={{ background: "#1A1D24", border: "1px solid #2A2E38", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#9499A6" }}
                  formatter={(v) => [`${(v * 100).toFixed(1)}%`, "ROAS"]}
                />
                <ReferenceLine y={TARGET_ROAS} stroke="#5D6270" strokeDasharray="4 4" label={{ value: "목표 40%", position: "insideTopRight", fill: "#6B7280", fontSize: 11 }} />
                {markDate7 && blendedAnalysis.chartData.some((d) => d.date === markDate7.slice(5)) && (
                  <ReferenceLine
                    x={markDate7.slice(5)}
                    stroke="#C9622B"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    label={{ value: "마지노선", position: "top", fill: "#C9622B", fontSize: 11 }}
                  />
                )}
                <Line type="monotone" dataKey="value" stroke="#5B8DEF" strokeWidth={2.2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function Rule2Panel({ campaignAnalysis, rule2Allocation, rule1Result }) {
  const [open, setOpen] = useState(true);
  if (!campaignAnalysis) return null;
  const { campaigns, benchmark, excludedCampaigns } = campaignAnalysis;
  const sorted = [...campaigns].sort((a, b) => (b.gap ?? -Infinity) - (a.gap ?? -Infinity));

  return (
    <SectionCard
      title="2. 캠페인 배분 룰"
      subtitle={benchmark != null ? `유료 전체 평균(기준선) ${fmtPct(benchmark)}` : ""}
      icon={<Target size={16} color="#5B8DEF" />}
      open={open} onToggle={() => setOpen((o) => !o)}
    >
      {rule2Allocation?.mode === "none" && (
        <div style={{
          background: "#161A22", border: "1px solid #2A2E38", borderRadius: 8, padding: "10px 14px",
          fontSize: 12.5, color: "#9499A6", marginBottom: 14, display: "flex", gap: 8, alignItems: "center",
        }}>
          <Info size={14} color="#5B8DEF" /> 1번 룰이 "조정 없음"이라 이번 사이클은 캠페인 간 배분이 발생하지 않습니다. 아래는 그룹 분류 참고용입니다.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ fontSize: 13 }}>
          <thead>
            <tr style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <th style={{ padding: "0 10px 10px 0" }}>캠페인</th>
              <th style={{ padding: "0 10px 10px" }}>7일MA ROAS</th>
              <th style={{ padding: "0 10px 10px" }}>14일MA ROAS</th>
              <th style={{ padding: "0 10px 10px" }}>그룹</th>
              <th style={{ padding: "0 10px 10px" }}>기준선 대비</th>
              <th style={{ padding: "0 10px 10px" }}>현재 예산</th>
              <th style={{ padding: "0 10px 10px" }}>제안 변경</th>
              <th style={{ padding: "0 0 10px 10px" }}>제안 예산</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const alloc = rule2Allocation?.perCampaign?.[c.name];
              return (
                <tr key={c.name} style={{ borderTop: "1px solid #1E2128" }}>
                  <td style={{ padding: "10px 10px 10px 0", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={c.name}>
                    {c.terminationFlag && <AlertOctagon size={13} color="#A4262C" style={{ marginRight: 5, verticalAlign: -2 }} />}
                    {c.name}
                  </td>
                  <td style={{ padding: "10px" }} className="mono">{fmtPct(c.ma7)}</td>
                  <td style={{ padding: "10px" }} className="mono">
                    <span style={{ color: c.terminationFlag ? "#A4262C" : "inherit", fontWeight: c.terminationFlag ? 700 : 400 }}>
                      {c.ma14 != null ? fmtPct(c.ma14) : "N/A"}
                    </span>
                  </td>
                  <td style={{ padding: "10px" }}>
                    <Badge color={c.group === "above" ? "#1E7B45" : "#A4262C"} text={c.group === "above" ? "상위" : "하위"} />
                  </td>
                  <td style={{ padding: "10px" }} className="mono">{fmtPp(c.gap)}</td>
                  <td style={{ padding: "10px" }} className="mono">{fmtMoney(c.currentBudget)}</td>
                  <td style={{ padding: "10px" }} className="mono">
                    <span style={{ color: alloc?.allocated > 0 ? "#1E7B45" : alloc?.allocated < 0 ? "#A4262C" : "#5D6270" }}>
                      {alloc?.allocated ? fmtMoneySigned(alloc.allocated) : "-"}
                    </span>
                  </td>
                  <td style={{ padding: "10px", fontWeight: 700 }} className="mono">{fmtMoney(alloc?.newBudget ?? c.currentBudget)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {excludedCampaigns.length > 0 && (
        <div style={{ marginTop: 16, fontSize: 12, color: "#5D6270" }}>
          제외됨 (데이터 부족 또는 일평균 비용 ${MIN_CAMPAIGN_COST_FOR_POOL} 이하): {excludedCampaigns.join(", ")}
        </div>
      )}
    </SectionCard>
  );
}

function InsightsPanel({ insights, expanded, onToggle }) {
  const iconMap = {
    danger: <AlertOctagon size={15} color="#A4262C" />,
    warn: <AlertTriangle size={15} color="#C9622B" />,
    good: <CheckCircle2 size={15} color="#1E7B45" />,
    info: <Info size={15} color="#5B8DEF" />,
  };
  return (
    <SectionCard
      title="추가 분석 및 의견"
      subtitle="룰 계산 결과를 바탕으로 자동 생성된 진단입니다. 최종 판단은 검토 후 적용하세요."
      icon={<Info size={16} color="#5B8DEF" />}
      open={expanded} onToggle={onToggle}
    >
      {insights.length === 0 ? (
        <EmptyNote text="특별히 주목할 신호가 없습니다." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {insights.map((ins, i) => (
            <div key={i} style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              background: "#161A22", borderRadius: 8, padding: "11px 14px", fontSize: 13, lineHeight: 1.6,
            }}>
              <div style={{ marginTop: 1 }}>{iconMap[ins.type]}</div>
              <div style={{ color: "#C5C8D1" }}>{ins.text}</div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function SectionCard({ title, subtitle, icon, open, onToggle, rightContent, children }) {
  return (
    <div style={{ marginTop: 24, background: "#13151A", border: "1px solid #23262E", borderRadius: 12, overflow: "hidden" }}>
      <div
        onClick={onToggle}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {icon}
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{subtitle}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {rightContent}
          {open ? <ChevronUp size={16} color="#6B7280" /> : <ChevronDown size={16} color="#6B7280" />}
        </div>
      </div>
      {open && <div style={{ padding: "0 22px 22px" }}>{children}</div>}
    </div>
  );
}

function MetricBox({ label, value, accent, icon }) {
  return (
    <div style={{ background: "#161A22", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 11.5, color: "#6B7280", marginBottom: 6 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 700, color: accent || "#E8E9ED", display: "flex", alignItems: "center", gap: 6 }}>
        {icon}{value}
      </div>
    </div>
  );
}

function Row({ label, value, bold, big, muted, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontSize: 12.5, color: muted ? "#5D6270" : "#9499A6" }}>{label}</span>
      <span className="mono" style={{
        fontSize: big ? 17 : 13.5, fontWeight: bold ? 700 : 400,
        color: accent || (muted ? "#6B7280" : "#E8E9ED"),
      }}>{value}</span>
    </div>
  );
}

function Badge({ color, text }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 5,
      background: `${color}22`, color,
    }}>{text}</span>
  );
}

function EmptyNote({ text }) {
  return (
    <div style={{ padding: "24px 0", textAlign: "center", color: "#5D6270", fontSize: 13 }}>{text}</div>
  );
}

const resetButtonStyle = {
  background: "transparent", border: "1px solid #2A2E38", color: "#9499A6",
  borderRadius: 8, padding: "9px 18px", fontSize: 13, cursor: "pointer",
};
