export function summarize(text: string) {
  return {
    todo: (text.match(/\[ \]/g) ?? []).length,
    doing: (text.match(/\[~\]/g) ?? []).length,
    done: (text.match(/\[x\]/g) ?? []).length,
  };
}
if (import.meta.main) console.log(JSON.stringify(summarize(await Bun.file(process.argv[2]!).text())));
