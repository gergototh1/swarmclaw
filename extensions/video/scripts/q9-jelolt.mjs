import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The blank-frame CANDIDATE (Q9). Not CI, not part of rule set 1, not
 * imported by qa.mjs: a script the operator runs by hand.
 *
 * Its origin is not qa_gate.py, which has no such rule. It is two other
 * places: the Hermes `video` extension's `BLANK_MAX_BYTES = 12_000` (the byte
 * length of a frame scaled down and encoded as PNG, calibrated on that
 * extension's own output, not on this kit's), and a measured case in the
 * kit's Scene.tsx (twelve blank frames at the end of gt-remotion-hu). So the
 * number below is another program's number. Spec 5.3 says how it earns a
 * place in rule set 2: run over the module's first ten `qa_ok` renders, it
 * must fail none of them. One passing render it flags means the threshold is
 * not this kit's, and the rule stays a candidate.
 *
 * What it measures, said plainly: every STEP_S seconds one frame is scaled to
 * 240 px wide and written as PNG; a frame whose PNG is under BLANK_MAX_BYTES
 * is reported with its timestamp. A flat colour compresses small; so does a
 * dark gradient, a fade, or a deliberately empty beat. The script reports
 * bytes, and only bytes.
 */
const BLANK_MAX_BYTES = 12_000
const STEP_S = 0.5

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('használat: node scripts/q9-jelolt.mjs <video.mp4> [...]  -- a modul első tíz qa_ok renderén futtatva; egy átmenő bukása = a küszöb nem ez a kité')
  process.exit(1)
}
for (const file of files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q9-'))
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `fps=1/${STEP_S},scale=240:-1`, path.join(dir, 'k%05d.png')])
    const blank = []
    for (const name of fs.readdirSync(dir).sort()) {
      const size = fs.statSync(path.join(dir, name)).size
      const index = Number(name.slice(1, 6)) - 1
      if (size < BLANK_MAX_BYTES) blank.push({ at_ms: Math.round(index * STEP_S * 1000), bajt: size })
    }
    console.log(JSON.stringify({ file, ures: blank, kuszob: BLANK_MAX_BYTES }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
