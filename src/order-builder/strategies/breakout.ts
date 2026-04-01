/**
 * breakout regime: trade only confirmed breakouts after compression (no blind first spike).
 */

import type { NormalizedFeatureSet, RegimeDetectionResult } from "../../utils/microstructure-regimes";

const EPS = 1e-9;

/** Recent window must include at least one compression tick (event count). */
export const COMPRESSION_LOOKBACK_EVENTS = 16;

/** Minimum break beyond rolling high/low (bps); spec 5–10. */
export const RANGE_BREAK_MIN_BPS = 5;

/** Max ticks to wait for confirmation after arming. */
export const ARM_MAX_AGE_TICKS = 3;

/** Max hold in processed events (between momentum 10 and flow 15). */
export const BREAKOUT_MAX_HOLD_EVENTS = 12;

export interface BreakoutArmPending {
    armedAtTick: number;
    direction: "up" | "down";
    breakoutLevel: number;
    rangeHigh: number;
    rangeLow: number;
}

export interface BreakoutEntrySnapshot {
    rangeHigh: number;
    rangeLow: number;
    direction: "up" | "down";
    midAtEntry: number;
}

export interface BreakoutEntryResult {
    shouldEnter: boolean;
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    direction: "up" | "down";
    confidence: number;
    reason: string;
    blockReason?: string;
    entrySnapshot?: BreakoutEntrySnapshot;
    pendingNext: BreakoutArmPending | null;
}

/** compression = realizedVolRank < 0.3 AND spreadPctRank < 0.4 */
export function isCompression(micro: NormalizedFeatureSet): boolean {
    return micro.pctRealizedVol < 0.3 && micro.pctSpreadPct < 0.4;
}

/** expansion = realizedVolRank >= 0.8 AND eventRateRank >= 0.75 */
export function isExpansion(micro: NormalizedFeatureSet): boolean {
    return micro.pctRealizedVol >= 0.8 && micro.pctEventRate >= 0.75;
}

/**
 * rangeBreak: mid breaks rolling high/low by marginBps (5–10 bps).
 */
export function rangeBreakWithMargin(
    micro: NormalizedFeatureSet,
    minBps: number = RANGE_BREAK_MIN_BPS,
): { ok: boolean; direction: "up" | "down" | null; bps: number } {
    const { mid, localRangeHigh, localRangeLow } = micro.raw;
    if (mid <= 0 || localRangeHigh <= localRangeLow + EPS) {
        return { ok: false, direction: null, bps: 0 };
    }
    const upBps = ((mid - localRangeHigh) / localRangeHigh) * 10000;
    const downBps = ((localRangeLow - mid) / localRangeLow) * 10000;
    if (upBps >= minBps) return { ok: true, direction: "up", bps: upBps };
    if (downBps >= minBps) return { ok: true, direction: "down", bps: downBps };
    return { ok: false, direction: null, bps: 0 };
}

export function hadCompressionInRecentWindow(recentCompressionFlags: readonly boolean[], lookback: number): boolean {
    if (recentCompressionFlags.length === 0) return false;
    const slice = recentCompressionFlags.slice(-lookback);
    return slice.some((x) => x);
}

function shallowPullbackHolds(micro: NormalizedFeatureSet, pending: BreakoutArmPending): boolean {
    const { mid } = micro.raw;
    const tol = 5 / 10000; // 5 bps tolerance below/above level
    if (pending.direction === "up") {
        return mid >= pending.breakoutLevel * (1 - tol);
    }
    return mid <= pending.breakoutLevel * (1 + tol);
}

/** Next event continues in breakout direction. */
function continuesBreakDirection(micro: NormalizedFeatureSet, direction: "up" | "down"): boolean {
    const r = micro.raw.return1;
    if (direction === "up") return r > EPS;
    return r < -EPS;
}

function confirmBreakout(micro: NormalizedFeatureSet, pending: BreakoutArmPending): { ok: boolean; detail: string } {
    const cont = continuesBreakDirection(micro, pending.direction);
    const shallow = shallowPullbackHolds(micro, pending);
    if (cont || shallow) {
        return { ok: true, detail: cont ? "confirm: direction continues" : "confirm: shallow pullback holds level" };
    }
    return { ok: false, detail: "confirm: no continuation and no shallow hold" };
}

function armGates(
    micro: NormalizedFeatureSet,
    rr: RegimeDetectionResult,
    hadCompressionWindow: boolean,
): { ok: boolean; rb: ReturnType<typeof rangeBreakWithMargin>; blockReason?: string } {
    if (rr.regime !== "breakout") {
        return { ok: false, rb: { ok: false, direction: null, bps: 0 }, blockReason: "regime != breakout" };
    }
    if (!hadCompressionWindow) {
        return { ok: false, rb: { ok: false, direction: null, bps: 0 }, blockReason: "no compression in recent window" };
    }
    if (!isExpansion(micro)) {
        return { ok: false, rb: { ok: false, direction: null, bps: 0 }, blockReason: "expansion not true" };
    }
    const rb = rangeBreakWithMargin(micro);
    if (!rb.ok || !rb.direction) {
        return { ok: false, rb, blockReason: "range break margin not met" };
    }
    if (Math.abs(micro.zOfiNorm) < 0.8) {
        return { ok: false, rb, blockReason: `abs(ofiNormZ)=${Math.abs(micro.zOfiNorm).toFixed(2)} < 0.8` };
    }
    return { ok: true, rb };
}

/** Lighter checks on confirm tick; expansion spike may not repeat. */
function confirmPathValid(
    micro: NormalizedFeatureSet,
    rr: RegimeDetectionResult,
    hadCompressionWindow: boolean,
    pending: BreakoutArmPending,
): { ok: boolean; blockReason?: string } {
    if (rr.regime !== "breakout") return { ok: false, blockReason: "regime != breakout" };
    if (!hadCompressionWindow) return { ok: false, blockReason: "no compression in recent window" };
    const { mid, localRangeHigh, localRangeLow } = micro.raw;
    const inside = mid >= localRangeLow - EPS && mid <= localRangeHigh + EPS;
    if (inside && !shallowPullbackHolds(micro, pending)) {
        return { ok: false, blockReason: "mid back inside range" };
    }
    return { ok: true };
}

export function computeBreakoutPositionSize(baseSize: number): number {
    const raw = baseSize * 0.8;
    return Math.max(1, Math.round(raw * 1000) / 1000);
}

/**
 * Two-phase: arm on first qualifying spike (HOLD), enter only after confirmation on a later tick.
 */
export function evaluateBreakoutEntry(
    micro: NormalizedFeatureSet,
    rr: RegimeDetectionResult,
    hadCompressionWindow: boolean,
    pending: BreakoutArmPending | null,
    processTick: number,
): BreakoutEntryResult {
    if (pending) {
        const age = processTick - pending.armedAtTick;
        if (age <= 0) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.direction,
                confidence: 0,
                reason: "breakout: same tick as arm",
                blockReason: "breakout: internal",
                pendingNext: pending,
            };
        }
        if (age > ARM_MAX_AGE_TICKS) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.direction,
                confidence: 0,
                reason: `breakout: arm stale (age=${age})`,
                blockReason: "breakout: confirmation timeout",
                pendingNext: null,
            };
        }

        const gates = confirmPathValid(micro, rr, hadCompressionWindow, pending);
        if (!gates.ok) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.direction,
                confidence: 0,
                reason: `breakout: confirm tick invalid (${gates.blockReason})`,
                blockReason: gates.blockReason,
                pendingNext: null,
            };
        }

        const rb = rangeBreakWithMargin(micro);
        if (rb.direction && rb.direction !== pending.direction) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.direction,
                confidence: 0,
                reason: "breakout: break direction changed",
                blockReason: "breakout: direction mismatch",
                pendingNext: null,
            };
        }

        const c = confirmBreakout(micro, pending);
        if (!c.ok) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.direction,
                confidence: 0,
                reason: c.detail,
                blockReason: c.detail,
                pendingNext: null,
            };
        }

        const { mid, localRangeHigh, localRangeLow } = micro.raw;
        const entrySnapshot: BreakoutEntrySnapshot = {
            rangeHigh: localRangeHigh,
            rangeLow: localRangeLow,
            direction: pending.direction,
            midAtEntry: mid,
        };
        const signal = pending.direction === "up" ? "BUY_UP" : "BUY_DOWN";
        const rbNote = rb.ok ? `bps=${rb.bps.toFixed(1)}` : "margin relaxed";
        return {
            shouldEnter: true,
            signal,
            direction: pending.direction,
            confidence: Math.min(1, Math.abs(micro.zOfiNorm) / 3),
            reason: `breakout ENTRY: ${c.detail} | ${rbNote} z=${micro.zOfiNorm.toFixed(2)}`,
            entrySnapshot,
            pendingNext: null,
        };
    }

    const gates = armGates(micro, rr, hadCompressionWindow);
    if (!gates.ok) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: 0,
            reason: gates.blockReason ?? "breakout: gates",
            blockReason: gates.blockReason,
            pendingNext: null,
        };
    }

    const rb = gates.rb;
    const direction = rb.direction!;
    const { localRangeHigh, localRangeLow } = micro.raw;
    const breakoutLevel = direction === "up" ? localRangeHigh : localRangeLow;

    const pendingNext: BreakoutArmPending = {
        armedAtTick: processTick,
        direction,
        breakoutLevel,
        rangeHigh: localRangeHigh,
        rangeLow: localRangeLow,
    };

    return {
        shouldEnter: false,
        signal: "HOLD",
        direction,
        confidence: 0,
        reason: `breakout ARM: await confirmation | bps=${rb.bps.toFixed(1)} z=${micro.zOfiNorm.toFixed(2)}`,
        blockReason: "breakout: awaiting confirmation (not first spike)",
        pendingNext,
    };
}

export function shouldExitBreakoutPosition(
    micro: NormalizedFeatureSet,
    entry: BreakoutEntrySnapshot,
): { exit: boolean; reason?: string } {
    const { mid } = micro.raw;
    if (mid >= entry.rangeLow - EPS && mid <= entry.rangeHigh + EPS) {
        return { exit: true, reason: "breakout failed: mid inside prior range" };
    }
    if (Math.abs(micro.zOfiNorm) < 0.3) {
        return { exit: true, reason: `ofiNormZ weakened: ${micro.zOfiNorm.toFixed(2)}` };
    }
    if (micro.pctSpreadPct > 0.85) {
        return { exit: true, reason: `spread rank too wide: ${micro.pctSpreadPct.toFixed(2)}` };
    }
    return { exit: false };
}

export function shouldForceExitBreakoutByHoldDuration(eventsSinceEntry: number): boolean {
    return eventsSinceEntry > BREAKOUT_MAX_HOLD_EVENTS;
}
