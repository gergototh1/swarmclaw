/**
 * An exported file should open with the doc's title. Most docs already start
 * with a `# ` heading, and repeating it would print the title twice, so the
 * title is only put in front when the first non-blank line is not a
 * level-one heading. Both the Word and the PDF export go through this.
 */
export function withTitleHeading(md: string, title: string): string {
  const clean = title.trim()
  if (clean === '') return md
  const first = md.split('\n').find((line) => line.trim() !== '') ?? ''
  if (/^#\s/.test(first)) return md
  return `# ${clean}\n\n${md}`
}
