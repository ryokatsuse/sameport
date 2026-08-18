import readline from "node:readline/promises";

export async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    process.stdout.write(`${question} [Y/n] y (--yes)\n`);
    return true;
  }
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
