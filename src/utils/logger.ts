import chalk from "chalk";
import { config } from "../config";

const timestamp = () => chalk.gray(new Date().toISOString());

type RegimeName =
  | "flow_dominance"
  | "momentum"
  | "breakout"
  | "reversal"
  | "liquidity_vacuum"
  | "expiry"
  | "chop";

type StrategyName = "flow_dominance" | "momentum" | "breakout" | "reversal";

export function colorRegime(regime: RegimeName | string): string {
  switch (regime) {
    case "flow_dominance":
      return chalk.blueBright.bold(regime);
    case "momentum":
      return chalk.greenBright.bold(regime);
    case "breakout":
      return chalk.yellowBright.bold(regime);
    case "reversal":
      return chalk.magentaBright.bold(regime);
    case "liquidity_vacuum":
      return chalk.redBright.bold(regime);
    case "expiry":
      return chalk.hex("#ff8c00").bold(regime);
    case "chop":
      return chalk.gray.bold(regime);
    default:
      return chalk.white.bold(regime);
  }
}

export function colorStrategy(strategy: StrategyName | string): string {
  return chalk.bold.underline(colorRegime(strategy));
}

export function colorSignal(signal: "BUY_UP" | "BUY_DOWN" | "HOLD" | string): string {
  if (signal === "BUY_UP") return chalk.greenBright.bold(signal);
  if (signal === "BUY_DOWN") return chalk.redBright.bold(signal);
  if (signal === "HOLD") return chalk.yellow.bold(signal);
  return chalk.white.bold(signal);
}

export const logger = {
  warning: (msg: string) =>
    console.log(
      `${timestamp()} ${chalk.bgYellow.black.bold(" WARNING ")} ${chalk.yellow(msg)}`
    ),

  info: (msg: string) =>
    console.log(
      `${timestamp()} ${chalk.bgCyan.black.bold(" INFO ")} ${chalk.cyan(msg)}`
    ),

  error: (msg: string, error?: Error | unknown) => {
    let errorMsg = msg;
    if (error) {
      const errorStr = error instanceof Error ? error.message : String(error);
      errorMsg = `${msg}: ${errorStr}`;
    }
    console.log(
      `${timestamp()} ${chalk.bgRed.white.bold(" ERROR ")} ${chalk.redBright.bold(errorMsg)}`
    );
  },

  debug: (msg: string) => {
    if (config.debug) {
      console.log(
        `${timestamp()} ${chalk.bgMagenta.white.bold(" DEBUG ")} ${chalk.magenta(msg)}`
      );
    }
  }
};
