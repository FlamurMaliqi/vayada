"use client";

import { ChartBarIcon } from "@heroicons/react/24/outline";
import { ChartPoint } from "@/services/api/growthDashboard";

function pointsPath(points: ChartPoint[], width: number, height: number, pad: number) {
  const max = Math.max(1, Math.ceil(Math.max(...points.map((p) => p.value), 1) / 4)) * 4;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : width - pad * 2;
  return points
    .map((point, index) => {
      const x = pad + index * step;
      const y = height - pad - (point.value / max) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function LineChart({
  points,
  tone = "lagoon",
  yLabel,
}: {
  points: ChartPoint[];
  tone?: "lagoon" | "brass";
  yLabel?: string;
}) {
  const width = 720;
  const height = 240;
  const pad = 48;
  if (points.length === 0) {
    return (
      <div className="relative min-h-[260px] overflow-hidden rounded-lg border border-gray-200 bg-white">
        <EmptyChart />
      </div>
    );
  }

  const max = Math.max(1, Math.ceil(Math.max(...points.map((p) => p.value), 1) / 4)) * 4;
  const line = pointsPath(points, width, height, pad);
  const area = `${line} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
  const stroke = tone === "brass" ? "#d97706" : "#374151";

  return (
    <div className="relative min-h-[260px] overflow-hidden rounded-lg border border-gray-200 bg-white">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[260px] w-full"
        role="img"
        aria-label={yLabel}
      >
        {yLabel && (
          <text
            transform="translate(12 120) rotate(-90)"
            textAnchor="middle"
            fontSize="11"
            fill="#6b7280"
          >
            {yLabel}
          </text>
        )}
        {[0, 1, 2, 3, 4].map((tick) => (
          <text
            key={tick}
            x={pad - 8}
            y={height - pad - (tick / 4) * (height - pad * 2) + 4}
            textAnchor="end"
            fontSize="11"
            fill="#6b7280"
          >
            {(max * tick) / 4}
          </text>
        ))}
        <path d={area} fill={stroke} opacity="0.12" />
        <path d={line} fill="none" stroke={stroke} strokeLinecap="round" strokeWidth="2.5" />
        {points.map((point, index) => {
          const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
          const x = pad + index * step;
          const y = height - pad - (point.value / max) * (height - pad * 2);
          return (
            <g key={`${point.key}-${index}`}>
              <circle cx={x} cy={y} r="4" fill={stroke}>
                <title>{`${point.label}: ${point.value}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <AxisLabels points={points} />
    </div>
  );
}

export function BarChart({ points, yLabel }: { points: ChartPoint[]; yLabel?: string }) {
  if (points.length === 0) {
    return (
      <div className="relative min-h-[260px] rounded-lg border border-gray-200 bg-white px-4 pb-8 pt-5">
        <EmptyChart />
      </div>
    );
  }

  const max = Math.max(1, Math.ceil(Math.max(...points.map((p) => p.value), 1) / 4)) * 4;
  return (
    <div
      role="img"
      aria-label={yLabel}
      className="relative min-h-[260px] rounded-lg border border-gray-200 bg-white pl-14 pr-4 pb-8 pt-5"
    >
      {yLabel && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 text-[11px] text-gray-500 [writing-mode:vertical-rl] rotate-180">
          {yLabel}
        </span>
      )}
      <div
        aria-hidden="true"
        className="absolute left-6 top-5 flex h-[210px] flex-col justify-between text-[11px] text-gray-500"
      >
        {[4, 3, 2, 1, 0].map((tick) => (
          <span key={tick} className="leading-none">
            {(max * tick) / 4}
          </span>
        ))}
      </div>
      <div className="flex h-[210px] items-end gap-2">
        {points.map((point) => (
          <div key={point.key} className="group flex h-full min-w-0 flex-1 items-end">
            <div
              className="w-full rounded-t bg-gray-500 transition group-hover:bg-gray-700"
              style={{ height: `${(point.value / max) * 100}%` }}
              title={`${point.label}: ${point.value}`}
            />
          </div>
        ))}
      </div>
      <AxisLabels points={points} />
    </div>
  );
}

function AxisLabels({ points }: { points: ChartPoint[] }) {
  const visible = points.filter((_, index) => {
    if (points.length <= 12) return true;
    return index === 0 || index === points.length - 1 || index % 5 === 0;
  });
  return (
    <div className="absolute inset-x-4 bottom-2 flex justify-between text-[11px] text-gray-400">
      {visible.map((point) => (
        <span key={point.key}>{point.label}</span>
      ))}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/80 text-[13px] text-gray-500">
      <ChartBarIcon className="h-5 w-5" aria-hidden="true" />
      No chart data
    </div>
  );
}
