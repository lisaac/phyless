// Keep each value literal when the generated command is pasted into a shell.
export function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
