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

async function
