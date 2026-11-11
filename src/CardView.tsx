import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { asset } from './asset'
import { cardLineKeys, defaultLook, type Art, type BoxPart, type CardLine, type Layout, type Look } from './cards'
import { aspects, epicText, isUnique, type Box, type Frame, type Spot, type TextBox } from './frames'

// One line of card text, placed on the frame and squeezed to fit its box.
function CardText(props: { frame: Frame; box: TextBox; className: string; text: string; unique?: boolean }) {
  const { frame, box, className, text, unique } = props
  const boxRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const boxEl = boxRef.current
    const textEl = textRef.current
    if (!boxEl || !textEl) return
    const fit = () => {
      textEl.style.transform = ''
      const scale = Math.min(1, boxEl.clientWidth / textEl.offsetWidth)
      textEl.style.transform = scale < 1 ? `scaleX(${scale})` : ''
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(boxEl)
    document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [text, unique])

  // Positions are percentages of the frame; the font scales with the card's width
  const style: CSSProperties = {
    left: `${(box.x / frame.width) * 100}%`,
    top: `${(box.y / frame.height) * 100}%`,
    width: `${(box.w / frame.width) * 100}%`,
    height: `${(box.h / frame.height) * 100}%`,
    fontSize: `${(box.size / frame.width) * 100}cqw`,
  }

  return (
    <div className={`card-text ${className}`} style={style} ref={boxRef}>
      <span ref={textRef}>
        {unique && <img className="unique-icon" src={asset('/icons/unique.png')} alt="Unique" />}
        {text}
      </span>
    </div>
  )
}

const numberKinds = ['cost', 'power', 'hp'] as const

// A cost, power or HP number: images cut from real cards by tools/extract_frames.py.
// With a sign, the number is a change (+2, -1), as printed on upgrades.
function CardNumber(props: {
  frame: Frame
  kind: (typeof numberKinds)[number]
  spot: Spot
  value: number
  signed: boolean
}) {
  const { frame, kind, spot, value, signed } = props
  const style: CSSProperties = {
    left: `${(spot.x / frame.width) * 100}%`,
    top: `${(spot.y / frame.height) * 100}%`,
    height: `${(spot.h / frame.height) * 100}%`,
  }
  // There are images for 0 to 15; a bigger number, like a base's HP, is set digit by digit
  const digits = Math.abs(value) <= 15 ? [String(Math.abs(value))] : [...String(Math.abs(value))]
  return (
    <div className="card-number" style={style}>
      {signed && <img className="card-sign" src={asset(`/icons/${kind}/${value < 0 ? 'minus' : 'plus'}.png`)} alt="" />}
      {digits.map((digit, index) => (
        <img key={index} src={asset(`/icons/${kind}/${digit}.png`)} alt={index === 0 ? `${kind} ${value}` : ''} />
      ))}
    </div>
  )
}

// A cost written in game text. [3] is the yellow resource icon with the number on
// it, for resources to pay or to pay less; [#3] is the number alone, in the cost
// font, for a card's cost being talked about: "a unit that costs [#3] or less".
function InlineCost(props: { number: string; plain: boolean }) {
  const { number, plain } = props
  // There are images for 0 to 15; a bigger number is set digit by digit
  const digits = Number(number) <= 15 ? [String(Number(number))] : [...number]
  const images = digits.map((digit, index) => (
    <img key={index} src={asset(`/icons/cost/${digit}.png`)} alt={index === 0 ? number : ''} />
  ))
  if (plain) return <span className="cost-number">{images}</span>
  return (
    <span className="cost-icon" style={{ backgroundImage: `url("${asset('/icons/cost-blank.png')}")` }}>
      <span>{images}</span>
    </span>
  )
}

// A power or HP number in game text, in the red-edged or blue-edged numbers, with
// its sign if it has one
function InlineStat(props: { kind: 'power' | 'hp'; number: string }) {
  const { kind, number } = props
  const sign = /^[+-]/.test(number) ? number[0] : ''
  return (
    <span className={sign ? 'stat-change stat-signed' : 'stat-change'}>
      {sign && <img className="stat-sign" src={asset(`/icons/${kind}/${sign === '-' ? 'minus' : 'plus'}.png`)} alt={sign} />}
      {[...number.slice(sign.length)].map((digit, index) => (
        <img key={index} src={asset(`/icons/${kind}/${digit}.png`)} alt={digit} />
      ))}
    </span>
  )
}

// A change to power and HP written in game text, like [+1/+0] or [-2/-2]: the power
// in the red-edged numbers, the HP in the blue-edged ones, with a slash between
function InlineChange(props: { power: string; hp: string }) {
  return (
    <span className="stat-changes">
      <InlineStat kind="power" number={props.power} />/<InlineStat kind="hp" number={props.hp} />
    </span>
  )
}

// The game's keywords. In game text they print in bold red capitals, with their number if any.
// So does the word Keywords, which some cards use to mean any of them.
const keywords = new Set([
  'ambush', 'bounty', 'coordinate', 'exploit', 'grit', 'hidden', 'overwhelm', 'piloting', 'plot', 'raid',
  'restore', 'saboteur', 'sentinel', 'shielded', 'smuggle', 'support', 'fortify',
  'keyword', 'keywords',
])
const isKeyword = (text: string) => keywords.has(text.replace(/\s*\d+$/, '').trim().toLowerCase())

// Text in curly brackets prints in italics: {Flip him and ready him.}
function Italics(props: { text: string }) {
  return props.text.split(/\{([^}]+)\}/).map((part, index) => (index % 2 === 0 ? part : <em key={index}>{part}</em>))
}

// Game text cut at its square brackets: text outside them, and what each pair holds.
// A pair can hold other pairs; a bracket with no partner is left as text.
function splitBrackets(text: string) {
  const parts: { text: string; bracketed: boolean }[] = []
  let plain = ''
  for (let at = 0; at < text.length; at++) {
    let end = -1
    if (text[at] === '[') {
      for (let depth = 0, to = at; to < text.length; to++) {
        if (text[to] === '[') depth++
        if (text[to] === ']' && --depth === 0) {
          end = to
          break
        }
      }
    }
    if (end < 0) {
      plain += text[at]
      continue
    }
    if (plain) parts.push({ text: plain, bracketed: false })
    plain = ''
    parts.push({ text: text.slice(at + 1, end), bracketed: true })
    at = end
  }
  if (plain) parts.push({ text: plain, bracketed: false })
  return parts
}

const isArrow = (text: string) => /^(arrow|exhaust)$/i.test(text.trim())

// The arrow that stands for exhausting the card, as part of an Action's cost
function ExhaustIcon() {
  return <img className="exhaust-icon" src={asset('/icons/exhaust.png')} alt="exhaust" />
}

// What one pair of square brackets prints
function Bracketed(props: { text: string }) {
  const { text } = props
  const cost = /^(#?)(\d{1,3})$/.exec(text)
  if (cost) return <InlineCost number={cost[2]} plain={cost[1] === '#'} />
  const change = /^([+-]\d{1,2})\/([+-]\d{1,2})$/.exec(text)
  if (change) return <InlineChange power={change[1]} hp={change[2]} />
  // One number alone: [P3] is a power, [H7] an HP
  const stat = /^([ph])([+-]?\d{1,2})$/i.exec(text)
  if (stat) return <InlineStat kind={stat[1].toLowerCase() === 'p' ? 'power' : 'hp'} number={stat[2]} />
  if (isArrow(text)) return <ExhaustIcon />
  // An aspect's name prints its icon: "a [Villainy] card"
  const aspect = aspects.find((name) => name.toLowerCase() === text.trim().toLowerCase())
  if (aspect) {
    return <img className="aspect-icon" src={asset(`/icons/aspect/${aspect.toLowerCase()}.png`)} alt={aspect} />
  }
  // A keyword of your own: # before it, as in [#Elusive] or [#Elusive 2]. A number
  // alone after # is a cost, above.
  const own = /^#\s*(\S.*)$/.exec(text)
  const keyword = own ? own[1] : isKeyword(text) ? text : null
  if (keyword) {
    return (
      <strong className="keyword">
        {/* All capitals, with each word's first letter taller */}
        {keyword.toUpperCase().split(/(\s+)/).map((word, at) =>
          /^[A-Z]/.test(word) ? (
            <span key={at}>
              {word[0]}
              <small>{word.slice(1)}</small>
            </span>
          ) : (
            word
          ),
        )}
      </strong>
    )
  }
  // Doubled brackets print the brackets themselves, around a cost: [[Arrow]] is the
  // arrow in brackets, [[1, Arrow]] a resource and the arrow, and [[2 Command Villainy]]
  // a resource and two aspect icons, as after PILOTING. A comma prints as a comma; a
  // space between two icons leaves a small gap, as on the cards.
  const inner = splitBrackets(text)
  if (inner.length === 1 && inner[0].bracketed) {
    const parts = inner[0].text.trim().split(/(\s*,\s*|\s+)/)
    return (
      <strong className="action-cost">
        [
        {parts.map((part, index) => {
          if (index % 2 === 1) return part.includes(',') ? ', ' : ' '
          const aspect = aspects.find((name) => name.toLowerCase() === part.toLowerCase())
          if (/^\d{1,3}$/.test(part)) return <InlineCost key={index} number={part} plain={false} />
          if (isArrow(part)) return <ExhaustIcon key={index} />
          if (aspect) {
            return (
              <img
                className="aspect-icon"
                key={index}
                src={asset(`/icons/aspect/${aspect.toLowerCase()}.png`)}
                alt={aspect}
              />
            )
          }
          return part
        })}
        ]
      </strong>
    )
  }
  return (
    <strong>
      <GameText text={text} />
    </strong>
  )
}

// Game text markup. In square brackets: [Hidden] or [Raid 2] prints a keyword in red,
// [1] prints a cost icon and [#1] a cost as a number, [+1/+0] a change to power and
// HP in their red and blue numbers, [P3] a power and [H7] an HP alone, [Arrow] the exhaust arrow, [Villainy] or another
// aspect's name its icon, and anything else,
// like [Action:], prints in bold. Bold text can hold any of those: [Action [[Arrow]]:].
// In curly brackets, text prints in italics, also inside bold: [{Imperial}] is a
// trait's bold italics.
export function GameText(props: { text: string }) {
  return splitBrackets(props.text).map((part, index) =>
    part.bracketed ? <Bracketed key={index} text={part.text} /> : <Italics key={index} text={part.text} />,
  )
}

// A Leader side's power and HP, printed small with a slash between them
function CardStats(props: {
  frame: Frame
  spot: Spot
  power?: number
  hp?: number
  // A pilot leader adds what it gives as an upgrade: 4/7 (+4/+4)
  upgradePower?: number
  upgradeHp?: number
}) {
  const { frame, spot, power, hp, upgradePower, upgradeHp } = props
  const change = (kind: 'power' | 'hp', value?: number) =>
    value !== undefined && (
      <>
        <img className="stat-sign" src={asset(`/icons/${kind}/${value < 0 ? 'minus' : 'plus'}.png`)} alt="" />
        <img src={asset(`/icons/${kind}/${Math.abs(value)}.png`)} alt={`${kind} ${value}`} />
      </>
    )
  const style: CSSProperties = {
    right: `${(1 - spot.x / frame.width) * 100}%`,
    top: `${(spot.y / frame.height) * 100}%`,
    height: `${(spot.h / frame.height) * 100}%`,
    fontSize: `${(spot.h / frame.width) * 100}cqw`,
  }
  return (
    <div className="card-stats" style={style}>
      {power !== undefined && <img src={asset(`/icons/power/${power}.png`)} alt={`power ${power}`} />}
      <span>/</span>
      {hp !== undefined && <img src={asset(`/icons/hp/${hp}.png`)} alt={`hp ${hp}`} />}
      {(upgradePower !== undefined || upgradeHp !== undefined) && (
        <>
          <span className="stats-gap">(</span>
          {change('power', upgradePower)}
          <span>/</span>
          {change('hp', upgradeHp)}
          <span>)</span>
        </>
      )}
    </div>
  )
}

// Sentinel is printed in a red box as wide as the text box, so it stands out across
// the table. A line typed between << and >> gets the box filled with a red tint,
// as on a unit that simply has Sentinel or an upgrade that gives it; between < and >
// it gets the outline alone, as when Sentinel depends on a condition. A line that
// is only [Sentinel] gets the filled box without being asked.
// endRoom keeps that much of the last line clear, in em, for what is printed in its corner.
function GameLines(props: { text: string; endRoom?: number }) {
  const lines = props.text.split('\n')
  return lines.map((line, index) => {
    const filled = /^\s*<<(.*)>>\s*$/.exec(line) ?? /^\s*(\[sentinel\])\s*$/i.exec(line)
    const outlined = filled ? null : /^\s*<(.*)>\s*$/.exec(line)
    const boxed = (filled ?? outlined)?.[1].trim() ?? line
    // A choice in a list: a line starting with - or * (or the dot itself) prints the dot
    // used between traits, with the choice's own lines lined up after it
    const choice = /^\s*[-*\u2022]\s+(.*)$/.exec(boxed)
    const text = choice ? choice[1] : boxed
    const className =
      [filled ? 'rule-box rule-box-filled' : outlined ? 'rule-box' : '', choice ? 'rule-choice' : ''].join(' ').trim() ||
      undefined
    return (
      <span className={className} key={index}>
        {choice && <span className="rule-dot">{'\u2022'}</span>}
        {/* An empty line still takes up a line */}
        {text === '' ? '\u00a0' : <GameText text={text} />}
        {index === lines.length - 1 && props.endRoom && (
          <span className="end-room" style={{ width: `${props.endRoom}em` }} />
        )}
      </span>
    )
  })
}

// Game text: wraps inside its box, and the font shrinks until it all fits.
function CardParagraph(props: { frame: Frame; box: TextBox; text: string; className?: string; endRoom?: number }) {
  const { frame, box, text, className = '', endRoom } = props
  const ref = useRef<HTMLDivElement>(null)
  const size = (box.size / frame.width) * 100

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      for (let scale = 1; scale >= 0.5; scale -= 0.04) {
        el.style.fontSize = `${size * scale}cqw`
        if (el.scrollHeight <= el.clientHeight) break
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [text, size])

  const style: CSSProperties = {
    left: `${(box.x / frame.width) * 100}%`,
    top: `${(box.y / frame.height) * 100}%`,
    width: `${(box.w / frame.width) * 100}%`,
    height: `${(box.h / frame.height) * 100}%`,
    fontSize: `${size}cqw`,
  }

  return (
    <div className={`card-rules ${className}`} style={style} ref={ref}>
      <p>
        <GameLines text={text} endRoom={endRoom} />
      </p>
    </div>
  )
}

// A pilot's text box holds two texts: the unit's, at the top, and below it the
// Piloting box, for when the card is played as an upgrade. That box prints what is
// typed for it, which starts with [Piloting] and its cost: [Piloting] [[2 Command]].
// It grows upward with its text, leaving the unit's text the rest. All of it shrinks
// together until it fits.
function PilotArea(props: { frame: Frame; text: string; pilotText: string }) {
  const { frame, text, pilotText } = props
  const box = frame.pilotBox!
  const textBox = frame.textBox!
  const ref = useRef<HTMLDivElement>(null)
  const size = (textBox.size / frame.width) * 100

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rules = el.firstElementChild as HTMLElement
    const fit = () => {
      for (let scale = 1; scale >= 0.5; scale -= 0.04) {
        el.style.fontSize = `${size * scale}cqw`
        if (el.scrollHeight <= el.clientHeight && rules.scrollHeight <= rules.clientHeight) break
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [text, pilotText, size])

  const style: CSSProperties = {
    left: `${(box.x / frame.width) * 100}%`,
    top: `${(box.y / frame.height) * 100}%`,
    width: `${(box.w / frame.width) * 100}%`,
    height: `${(box.h / frame.height) * 100}%`,
    fontSize: `${size}cqw`,
  }
  // The unit's text keeps the text box's own margins inside the wider Piloting box
  const inset = {
    marginLeft: `${((textBox.x - box.x) / box.w) * 100}%`,
    marginRight: `${((box.x + box.w - textBox.x - textBox.w) / box.w) * 100}%`,
  }
  return (
    <div className="pilot-area" style={style} ref={ref}>
      <div className="card-rules pilot-unit-text" style={inset}>
        <p>
          <GameLines text={text} />
        </p>
      </div>
      <div className="pilot-box" hidden={frame.type === 'Leader' && !pilotText}>
        <p>{pilotText ? <GameLines text={pilotText} /> : '\u00a0'}</p>
      </div>
    </div>
  )
}

// The frame can be faded in parts: the top, down to the power and HP icons, and the
// rest below; and what the card says can be kept solid. Each part is the frame
// again, cut to its shape, at its own opacity. Undefined when the whole frame is one
// opacity.
// How solid each part of the frame is: the top, down to the power and HP icons, and
// the rest below
function fadeLevels(look: Look) {
  return {
    top: look.fadeTop === false ? 1 : look.frameOpacity,
    bottom: look.fadeBottom === false ? 1 : look.frameOpacity,
  }
}

// The mask of the words in the bar along the top of the frame, cut from the frames by
// tools/extract_frames.py; undefined for frames whose bar has other words, or none
function labelMask(frame: Frame) {
  const arena = frame.arena === 'Space' ? 'space' : 'ground'
  const name =
    frame.type === 'Token'
      ? undefined
      : frame.token
        ? // TOKEN UNIT; on a token without a text box, the bar is 2 px lower
          `token-unit-${frame.textBox ? '' : 'solo-'}${arena}`
        : frame.type === 'Base'
        ? 'base'
        : frame.type === 'Leader'
        ? frame.width > frame.height
          ? 'leader'
          : `leader-unit-${arena}`
        : frame.type === 'Unit'
          ? `unit-${arena}`
          : frame.type === 'Event'
            ? 'event'
            : 'upgrade'
  return name && asset(`/icons/labels/${name}.png`)
}

function frameParts(frame: Frame, look: Look) {
  const { top, bottom } = fadeLevels(look)
  const areas = solidAreas(frame, look.solidText === true, look.solidIcons === true)
  // Only worth drawing again where something is faded
  const keep = (areas.length > 0 || (look.solidIcons === true && labelMask(frame) !== undefined)) && (top < 1 || bottom < 1)
  if (top === bottom && !keep) return undefined
  // Where the top ends: just above the power and HP icons, which reach about a number's
  // height above their middle, or above the text box on a card without them
  const box = frame.textBox
  const stat = frame.power ?? frame.hp
  const split = stat ? stat.y - stat.h - 6 : box ? box.y - 15 : frame.height * 0.6
  const pct = (value: number, of: number) => `${(Math.max(0, Math.min(of, value)) / of) * 100}%`
  const shape = (x: number, y: number, w: number, h: number) =>
    `polygon(${[
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]
      .map(([px, py]) => `${pct(px, frame.width)} ${pct(py, frame.height)}`)
      .join(', ')})`
  const parts: { clip?: string; mask?: string; src?: string; opacity: number; part?: BoxPart }[] = [
    { clip: shape(0, 0, frame.width, split), opacity: top },
    { clip: shape(0, split, frame.width, frame.height - split), opacity: bottom },
  ]
  // Kept solid, drawn again over the faded frame
  const solid: typeof parts = areas.map(({ clip, part }) => ({ clip, part, opacity: 1 }))
  // The words along the top, UNIT and GROUND and so on, cut out letter by letter
  const label = look.solidIcons ? labelMask(frame) : undefined
  if (label && (top < 1 || bottom < 1)) solid.push({ mask: label, opacity: 1, part: 'label' })
  // A base's HP icon: on the frame, the name bar covers its right edge, so it is drawn from its
  // own image, that edge finished (tools/extract_frames.py)
  if (look.solidIcons && frame.type === 'Base' && top < 1) solid.push({ src: '/icons/base-hp.png', opacity: 1, part: 'hp' })
  return keep || solid.length ? [...parts, ...solid] : parts
}

// Where a unit's power and HP icons sit, and their outlines there, x and y by turns: what is
// the same on every unit frame, the shadow under each with it, a pixel more where the frame is
// clear around, and none of the trait bar or text box beside them
const UNIT_STATS_Y = 638
const POWER_OUTLINE = [
  73, 577, 73, 578, 71, 578, 70, 580, 68, 580, 66, 582, 48, 582, 46, 584, 46, 587, 45, 587, 46, 589, 44, 590, 44,
  592, 42, 594, 40, 594, 38, 596, 33, 596, 32, 598, 27, 598, 25, 600, 27, 615, 29, 616, 29, 661, 28, 661, 28, 665,
  27, 665, 28, 676, 33, 677, 33, 678, 37, 678, 37, 679, 42, 680, 42, 681, 45, 681, 47, 686, 48, 686, 49, 691, 66,
  691, 66, 692, 68, 692, 70, 694, 78, 694, 78, 693, 80, 693, 82, 691, 99, 691, 99, 688, 102, 685, 103, 681, 109, 680,
  109, 679, 111, 679, 113, 677, 116, 677, 116, 676, 120, 676, 118, 662, 117, 662, 116, 627, 117, 627, 118, 622, 119,
  622, 118, 619, 119, 619, 119, 614, 120, 614, 120, 610, 121, 610, 120, 608, 122, 606, 122, 600, 120, 598, 114, 597,
  114, 595, 112, 593, 106, 593, 103, 590, 104, 587, 102, 586, 103, 583, 101, 581, 80, 581, 80, 580, 77, 580, 74, 577,
]
const HP_OUTLINE = [
  648, 584, 648, 585, 628, 585, 628, 586, 617, 587, 616, 589, 609, 590, 609, 591, 599, 591, 593, 597, 593, 601, 594,
  601, 593, 605, 594, 606, 593, 606, 593, 612, 590, 614, 590, 618, 591, 618, 591, 625, 592, 625, 592, 628, 594, 630,
  594, 635, 595, 635, 595, 638, 596, 638, 595, 646, 594, 646, 594, 649, 592, 651, 592, 659, 593, 659, 593, 663, 594,
  663, 595, 670, 596, 670, 596, 684, 598, 684, 600, 686, 611, 686, 613, 688, 616, 688, 616, 689, 618, 689, 620, 691,
  624, 691, 624, 692, 654, 692, 656, 690, 659, 690, 660, 688, 663, 688, 664, 686, 677, 686, 677, 685, 679, 685, 682,
  682, 683, 668, 684, 668, 685, 661, 686, 661, 686, 650, 685, 650, 685, 646, 684, 646, 684, 643, 683, 643, 683, 638,
  684, 638, 684, 633, 686, 631, 686, 622, 687, 622, 687, 619, 689, 618, 688, 617, 689, 613, 687, 611, 683, 610, 683,
  605, 684, 605, 683, 599, 684, 599, 684, 596, 680, 592, 677, 592, 677, 591, 665, 591, 664, 589, 662, 589, 660, 587,
  651, 586, 649, 584,
]

// An upgrade's power and HP modifiers, where they sit and their outlines there, traced the same
// way on the upgrade frames. They come from different scans, a pixel or two apart: each
// outline is the widest, its border kept on all of them. Under them, the shadow goes into the
// card's dark bottom edge, which fades with the frame
const UPGRADE_POWER_Y = 890
const UPGRADE_HP_Y = 888
const UPGRADE_POWER_OUTLINE = [
  72, 830, 72, 831, 67, 831, 67, 833, 64, 833, 63, 835, 48, 835, 48, 836, 47, 836, 47, 838, 46, 838, 46, 840, 45,
  840, 43, 843, 39, 843, 38, 845, 34, 845, 33, 847, 28, 847, 28, 848, 26, 848, 26, 849, 25, 849, 25, 853, 26, 853,
  25, 858, 28, 860, 28, 862, 29, 862, 29, 867, 30, 867, 30, 869, 29, 869, 29, 873, 30, 873, 30, 876, 29, 876, 29,
  878, 30, 878, 30, 894, 29, 894, 29, 900, 30, 900, 30, 912, 29, 912, 29, 916, 28, 916, 28, 922, 27, 922, 28, 924,
  27, 924, 27, 926, 28, 926, 28, 927, 31, 927, 31, 928, 34, 928, 34, 929, 36, 930, 36, 932, 37, 932, 37, 933, 43,
  933, 43, 937, 44, 940, 48, 943, 56, 946, 80, 946, 100, 944, 108, 941, 111, 938, 111, 937, 111, 936, 109, 936, 106,
  932, 113, 931, 113, 929, 116, 929, 117, 927, 120, 927, 120, 926, 122, 925, 122, 924, 121, 924, 121, 917, 120, 917,
  120, 913, 119, 913, 119, 894, 120, 894, 120, 883, 119, 883, 119, 863, 120, 863, 120, 858, 121, 858, 121, 854, 122,
  854, 122, 853, 121, 853, 121, 850, 116, 850, 116, 849, 111, 848, 111, 846, 106, 845, 109, 841, 103, 841, 103, 839,
  101, 838, 101, 834, 86, 834, 86, 833, 80, 833, 78, 830,
]
const UPGRADE_HP_OUTLINE = [
  597, 836, 597, 837, 602, 838, 603, 840, 605, 840, 605, 841, 607, 842, 607, 843, 597, 843, 597, 844, 596, 844, 596,
  846, 595, 846, 595, 862, 594, 862, 594, 864, 593, 864, 593, 868, 592, 868, 592, 880, 593, 880, 593, 883, 592, 883,
  592, 890, 591, 890, 591, 893, 592, 893, 592, 917, 593, 917, 593, 926, 594, 926, 594, 929, 595, 929, 595, 934, 596,
  934, 596, 936, 597, 936, 598, 938, 600, 940, 612, 943, 632, 945, 650, 945, 662, 943, 672, 940, 681, 938, 683, 938,
  682, 918, 684, 917, 684, 910, 685, 910, 685, 907, 686, 907, 686, 906, 685, 906, 686, 902, 685, 902, 685, 900, 684,
  900, 684, 896, 683, 896, 684, 881, 685, 881, 685, 878, 686, 878, 686, 870, 685, 870, 685, 865, 684, 865, 684, 862,
  683, 862, 683, 853, 681, 852, 681, 849, 683, 848, 683, 846, 682, 846, 682, 844, 681, 844, 679, 841, 677, 841, 677,
  840, 661, 839, 660, 837, 653, 837, 653, 836,
]

// An event's column of aspect icons, for one, two or three icons. Around them the frame is
// not clear but the white text panel and its colored tab, so they are cut to the icons
// themselves: the first as on the unit frames, those under it as tools/compose_frames.py
// prints them, from their alpha, only the pixels more icon than frame (the soft edge of
// their shadow, blended into the panel, would show as a pale fringe). Under the last icon,
// only its dark shadow, as dark on every event frame with that many icons: past it, the tab
const EVENT_ASPECTS_OUTLINES = [
  [
    34, 117, 34, 187, 44, 187, 44, 188, 46, 188, 46, 189, 50, 189, 50, 190, 55, 190, 55, 191, 59, 191, 59, 192, 63,
    192, 63, 193, 66, 193, 66, 194, 71, 194, 71, 195, 75, 195, 75, 194, 80, 194, 80, 193, 82, 193, 82, 192, 87, 192,
    87, 191, 90, 191, 90, 190, 95, 190, 95, 189, 98, 189, 98, 188, 101, 188, 101, 187, 108, 187, 108, 117,
  ],
  [
    34, 117, 34, 187, 40, 187, 40, 188, 44, 188, 44, 189, 43, 189, 43, 190, 39, 190, 39, 191, 37, 191, 37, 256, 38,
    256, 38, 257, 39, 257, 39, 258, 44, 258, 44, 259, 46, 259, 46, 260, 52, 260, 52, 261, 56, 261, 56, 262, 60, 262,
    60, 263, 64, 263, 64, 264, 67, 264, 67, 265, 71, 265, 71, 266, 72, 266, 72, 265, 78, 265, 78, 264, 81, 264, 81,
    263, 84, 263, 84, 262, 88, 262, 88, 261, 93, 261, 93, 260, 95, 260, 95, 259, 98, 259, 98, 258, 103, 258, 103,
    257, 108, 257, 108, 191, 106, 191, 106, 190, 102, 190, 102, 189, 100, 189, 100, 188, 103, 188, 103, 187, 108,
    187, 108, 117,
  ],
  [
    34, 117, 34, 187, 40, 187, 40, 188, 44, 188, 44, 189, 43, 189, 43, 190, 39, 190, 39, 191, 37, 191, 37, 256, 38,
    256, 38, 258, 42, 258, 42, 259, 39, 259, 39, 260, 37, 260, 37, 325, 38, 325, 38, 326, 39, 326, 39, 327, 43, 327,
    43, 328, 48, 328, 48, 329, 51, 329, 51, 330, 56, 330, 56, 331, 59, 331, 59, 332, 63, 332, 63, 333, 66, 333, 66,
    334, 72, 334, 72, 335, 75, 335, 75, 334, 79, 334, 79, 333, 81, 333, 81, 332, 86, 332, 86, 331, 89, 331, 89, 330,
    94, 330, 94, 329, 97, 329, 97, 328, 100, 328, 100, 327, 106, 327, 106, 326, 108, 326, 108, 260, 106, 260, 106,
    259, 103, 259, 103, 258, 107, 258, 107, 257, 108, 257, 108, 191, 106, 191, 106, 190, 102, 190, 102, 189, 100,
    189, 100, 188, 103, 188, 103, 187, 108, 187, 108, 117,
  ],
]

// What stays solid while the frame fades, as clip-path shapes. Text boxes: the game
// text box (on a pilot, the Piloting box with it), and the name and subtitle bars.
// Icons: cost, aspects, power and HP, the upgrade's modifiers among them, each cut
// to the icon's own outline, measured on the frames. (The words in the bar along the
// top go with the icons too: see labelMask.)
function solidAreas(frame: Frame, text: boolean, icons: boolean): { clip: string; part: BoxPart }[] {
  const areas: { clip: string; part: BoxPart }[] = []
  // Which part of the card the outlines added next belong to, to move with it
  let part: BoxPart = 'text'
  const add = (clip: string) => areas.push({ clip, part })
  const px = (x: number) => `${(x / frame.width) * 100}%`
  const py = (y: number) => `${(y / frame.height) * 100}%`
  const polygon = (points: [number, number][]) => `polygon(${points.map(([x, y]) => `${px(x)} ${py(y)}`).join(', ')})`
  const rect = (b: { x: number; y: number; w: number; h: number }, by = 0) =>
    polygon([
      [b.x - by, b.y - by],
      [b.x + b.w + by, b.y - by],
      [b.x + b.w + by, b.y + b.h + by],
      [b.x - by, b.y + b.h + by],
    ])
  // A hexagon standing on a point, as the cost and aspect icons are
  const hexagon = (x0: number, y0: number, x1: number, y1: number) => {
    const cx = (x0 + x1) / 2
    const corner = (y1 - y0) * 0.24
    return polygon([
      [cx, y0],
      [x1, y0 + corner],
      [x1, y1 - corner],
      [cx, y1],
      [x0, y1 - corner],
      [x0, y0 + corner],
    ])
  }
  // The power icon: a gem standing on a point, its spiky shoulders a little above
  // its middle and its lower corners a little below
  const gem = (x: number, y: number) =>
    polygon([
      [x, y - 60],
      [x + 42, y - 40],
      [x + 42, y + 30],
      [x, y + 52],
      [x - 43, y + 30],
      [x - 43, y - 40],
    ])
  // The HP icon: round
  const round = (x0: number, y0: number, x1: number, y1: number) =>
    `ellipse(${(((x1 - x0) / 2 / frame.width) * 100).toFixed(3)}% ${(((y1 - y0) / 2 / frame.height) * 100).toFixed(3)}% at ${px((x0 + x1) / 2)} ${py((y0 + y1) / 2)})`

  const box = frame.textBox
  if (text) {
    part = 'text'
    if (frame.pilotBox) {
      add(rect({ ...frame.pilotBox, y: frame.pilotBox.y - 18, h: frame.pilotBox.h + 18 }))
    } else if (box) {
      const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
      const panel = frame.panels.find(
        (p) => p.x <= middle.x && middle.x <= p.x + p.w && p.y <= middle.y && middle.y <= p.y + p.h,
      )
      add(panel ? rect(panel, 6) : rect(box, 12))
    }
    part = 'name'
    for (const name of [frame.nameBox, frame.nameBox2]) if (name) add(rect(name, 9))
    if (frame.subtitle) add(rect(frame.subtitle.box, 8))
  }
  if (icons) {
    // Each icon's outline around where its number is printed, as measured on the frames
    // The cost icon on a card standing up is the same on every frame, wherever its number sits:
    // a point on top, corners 12 px lower, and two lobes under it, its border all kept. With no
    // aspect icon under it, it is a whole hexagon, with a point at the bottom too (on a token
    // without a text box, all of it 2 px lower and to the right)
    part = 'cost'
    // A leader's are down its right side, so its cost icon is whole too
    if (frame.cost && frame.height > frame.width && (!frame.aspects.length || frame.type === 'Leader')) {
      const dx = frame.cost.x - 72.5
      const dy = frame.cost.y - 73.5
      add(
        polygon(
          [
            [27, 39],
            // Right of the point, the name bar's top line runs on over it: cut along the icon's
            // own outline, just under that line
            [70, 28],
            [76, 29.6],
            [117, 40],
            [117, 116],
            [72.5, 129],
            [27, 116],
          ].map(([x, y]) => [x + dx, y + dy]),
        ),
      )
    } else if (frame.cost && frame.height > frame.width) {
      add(
        polygon([
          [27, 40],
          [72.5, 27],
          [117, 40],
          [117, 117],
          [100, 121],
          [45, 121],
          [27, 117],
        ]),
      )
    } else if (frame.cost) {
      const { x, y } = frame.cost
      add(hexagon(x - 43, y - 38, x + 42, y + 43))
    }
    // The power and HP icons cut to their outlines as traced on the frames: a unit's (a pilot's
    // 118 px higher, a token unit's lower, the icons the same), and an upgrade's modifiers (a
    // pilot's too, where they print the same).
    // Any other, to the shapes below
    const traced = (spot: { y: number }, outlines: [number, number[]][]) => {
      for (const [y, outline] of outlines) {
        const dy = spot.y - y
        if (dy !== 0 && !(y === UNIT_STATS_Y && (dy === -118 || frame.token))) continue
        const points: [number, number][] = []
        for (let i = 0; i < outline.length; i += 2) points.push([outline[i], outline[i + 1] + dy])
        add(polygon(points))
        return true
      }
      return false
    }
    const powerOutlines: [number, number[]][] = [
      [UNIT_STATS_Y, POWER_OUTLINE],
      [UPGRADE_POWER_Y, UPGRADE_POWER_OUTLINE],
    ]
    const hpOutlines: [number, number[]][] = [
      [UNIT_STATS_Y, HP_OUTLINE],
      [UPGRADE_HP_Y, UPGRADE_HP_OUTLINE],
    ]
    part = 'power'
    for (const spot of [frame.power, frame.upgradePower]) {
      if (spot && !traced(spot, powerOutlines)) add(gem(spot.x, spot.y))
    }
    // Its left edge stops short of the notch in the gem, where the frame's border (its
    // aspect's color on a Heroism frame) shows through
    // A base's HP icon is drawn whole, from an image of its own (see frameParts)
    part = 'hp'
    if (frame.type !== 'Base') {
      for (const spot of [frame.hp, frame.upgradeHp]) {
        if (spot && !traced(spot, hpOutlines)) add(round(spot.x - 41, spot.y - 48, spot.x + 45, spot.y + 49))
      }
    }
    // The aspect icons: under the cost on most cards, one under another; down the
    // right side on a leader
    part = 'aspects'
    if (frame.type === 'Leader') {
      // Shaped as the cost icon is: a low point on top, just under the name bar's line, its
      // corners 9 px lower, as traced on the frames; one under another, 110 px apart
      frame.aspects.forEach((_, index) => {
        const dy = index * 110
        // Its bottom: the outline's shadow, deepest a little left of the middle, the frame's
        // subtitle bar showing under it at the left
        const outline: [number, number][] =
          frame.width > frame.height
            ? [
                [880, 40],
                [923, 31],
                [968, 40],
                [968, 127],
                [936, 127],
                [923, 131],
                [880, 120],
              ]
            : [
                [600, 39],
                [644, 31],
                [688, 40],
                [688, 127],
                [662, 127],
                [644, 132],
                [600, 121],
              ]
        add(polygon(outline.map(([x, y]) => [x, y + dy])))
      })
    } else if (frame.type === 'Event' && EVENT_ASPECTS_OUTLINES[frame.aspects.length - 1]) {
      const outline = EVENT_ASPECTS_OUTLINES[frame.aspects.length - 1]
      const points: [number, number][] = []
      for (let i = 0; i < outline.length; i += 2) points.push([outline[i], outline[i + 1]])
      add(polygon(points))
    } else if (frame.type === 'Base' && frame.aspects.length) {
      // A base's one icon, top right beside the name bar: a hexagon with a point at top and
      // bottom, its upper left edge sloping away from the bar
      add(
        polygon([
          [879, 40],
          [922, 27],
          [969, 40],
          [971, 121],
          [950, 128],
          [924, 136],
          [898, 128],
          [878, 121],
        ]),
      )
    } else if (frame.aspects.length) {
      // The column of icons, cut as one: around them the frame is clear, but on an event,
      // where the white text panel starts at x 108, and on an upgrade or fortification, whose
      // icons' border reaches a pixel wider. At the bottom, the shadow the frame draws under
      // the last icon, a point 10 px deep. A second icon sits 72 px under the first, a third
      // 69 px under that (tools/compose_frames.py).
      const o = frame.aspects.length === 1 ? 0 : 72 + (frame.aspects.length - 2) * 69
      const right = frame.type === 'Event' ? 108 : 110
      add(
        polygon([
          [34, 117],
          [right, 117],
          [right, 186 + o],
          [104, 188 + o],
          [96, 190 + o],
          [87, 192 + o],
          [80, 194 + o],
          [77, 196 + o],
          [71, 196 + o],
          [65, 194 + o],
          [57, 192 + o],
          [49, 190 + o],
          [43, 188 + o],
          [34, 186 + o],
        ]),
      )
    }
  }
  return areas
}

// The text panels, each with the part it backs, to move with it: the one holding a box's middle.
// A leader's game text and Epic Action box share one panel, cut between them so each can go its
// own way.
export function panelParts(frame: Frame): { box: Box; part?: BoxPart }[] {
  const holds = (panel: Box, box?: Box) =>
    box !== undefined &&
    panel.x <= box.x + box.w / 2 &&
    box.x + box.w / 2 <= panel.x + panel.w &&
    panel.y <= box.y + box.h / 2 &&
    box.y + box.h / 2 <= panel.y + panel.h
  const owners: [Box | undefined, BoxPart][] = [
    [frame.pilotBox ?? frame.textBox, 'text'],
    [frame.traitBox, 'trait'],
    [frame.nameBox, 'name'],
    [frame.nameBox2, 'name'],
    [frame.subtitle?.box, 'name'],
  ]
  return frame.panels.flatMap((panel): { box: Box; part?: BoxPart }[] => {
    const text = frame.textBox
    const epic = frame.epicBox
    if (text && epic && holds(panel, text) && holds(panel, epic)) {
      const cut = Math.round((text.y + text.h + epic.y) / 2)
      return [
        { box: { ...panel, h: cut - panel.y }, part: 'text' },
        { box: { ...panel, y: cut, h: panel.y + panel.h - cut }, part: 'epic' },
      ]
    }
    return [{ box: panel, part: owners.find(([box]) => holds(panel, box))?.[1] }]
  })
}

// Where each part a card has sits on its frame, in the frame's pixels: what to grab to move it
export function partBoxes(frame: Frame): { part: BoxPart; box: Box }[] {
  const boxes: { part: BoxPart; box: Box }[] = []
  const around = (part: BoxPart, ...list: (Box | undefined)[]) => {
    const all = list.filter((box): box is Box => box !== undefined)
    if (!all.length) return
    const x = Math.min(...all.map((box) => box.x))
    const y = Math.min(...all.map((box) => box.y))
    const w = Math.max(...all.map((box) => box.x + box.w)) - x
    const h = Math.max(...all.map((box) => box.y + box.h)) - y
    boxes.push({ part, box: { x, y, w, h } })
  }
  const panels = panelParts(frame)
  const backing = (part: BoxPart) => panels.filter((panel) => panel.part === part).map(({ box }) => box)
  const icon = (spot: Spot | undefined, r: number) => spot && { x: spot.x - r, y: spot.y - r, w: r * 2, h: r * 2 }
  const landscape = frame.width > frame.height
  around('text', frame.pilotBox ?? frame.textBox, ...backing('text'))
  const stats = frame.stats && { x: frame.stats.x - 60, y: frame.stats.y - frame.stats.h / 2, w: 60, h: frame.stats.h }
  around('epic', frame.epicBox, stats, ...backing('epic'))
  around('trait', frame.traitBox, ...backing('trait'))
  around('name', frame.nameBox, frame.nameBox2, frame.subtitle?.box, ...backing('name'))
  // The words along the top bar: roughly where they print
  if (frame.type !== 'Token') around('label', landscape ? { x: 40, y: 22, w: 380, h: 34 } : { x: 120, y: 22, w: 480, h: 34 })
  around('cost', icon(frame.cost, 45))
  if (frame.aspects.length) {
    const n = frame.aspects.length
    around(
      'aspects',
      frame.type === 'Leader'
        ? { x: landscape ? 880 : 600, y: 31, w: 88, h: 101 + (n - 1) * 110 }
        : frame.type === 'Base'
          ? { x: 878, y: 27, w: 93, h: 109 }
          : { x: 34, y: 117, w: 76, h: 79 + (n === 1 ? 0 : 72 + (n - 2) * 69) },
    )
  }
  around('power', icon(frame.power, 48), icon(frame.upgradePower, 40))
  around('hp', icon(frame.hp, frame.type === 'Base' ? 60 : 48), icon(frame.upgradeHp, 40))
  return boxes
}

// A moved part: shifted by its offset, in the card's own width so it holds at any size
function shiftOf(frame: Frame, layout: Layout | undefined, part: BoxPart | undefined): CSSProperties | undefined {
  const at = part && layout?.[part]
  if (!at || (!at.x && !at.y)) return undefined
  return { transform: `translate(${(at.x / frame.width) * 100}cqw, ${(at.y / frame.width) * 100}cqw)` }
}

// What a moved part prints, drawn in a layer of the card's size that is shifted as a whole
function Shifted(props: { shift?: CSSProperties; children: ReactNode }) {
  return props.shift ? (
    <div className="card-part" style={props.shift}>
      {props.children}
    </div>
  ) : (
    props.children
  )
}

// The gold bar of a Legends card, cut from real ones by tools/extract_legends.py: along the
// bottom of a unit, an event or a leader's unit side, longer along a leader's front, and
// higher, between the game text and the box under it, on an upgrade, a fortification or a
// pilot. Tokens, cut from 716 px scans as the Legends cards were, take the bar as cut: a
// token unit where a unit has it, other tokens (upgrade, Spice, Credit) along the bottom of
// their text box, where an upgrade has it. Always solid: it is printed over the frame,
// whatever the frame's opacity. No Legends base was ever printed: a base takes the long bar
// on the strip above its trait, a best guess.
function legendsBar(frame: Frame) {
  if (frame.type === 'Base') return 'base'
  if (frame.token) return 'token-unit'
  if (frame.type === 'Token') return 'token-upgrade'
  if (frame.type === 'Leader' && frame.width > frame.height) return 'leader'
  return frame.type === 'Upgrade' || frame.type === 'Fortification' || frame.pilotBox ? 'upgrade' : 'unit'
}

// The line along the bottom of a card, on a dark band across the art: the artist,
// the block (a little left of the middle, as printed), the set and language, the
// rarity's symbol and the card's number
const rarityNames: Record<string, string> = { C: 'Common', U: 'Uncommon', R: 'Rare', S: 'Special', L: 'Legendary' }

function CardLine(props: { frame: Frame; line: CardLine }) {
  const { frame, line } = props
  const landscape = frame.width > frame.height
  // Where the band sits, as on the printed cards
  const box = landscape
    ? { x: 30 / 1000, y: 660 / 718, w: 940 / 1000, h: 31 / 718 }
    : { x: 32 / 718, y: 937 / 1000, w: 651 / 718, h: 35 / 1000 }
  // The text is the same size on every card, measured on its short side
  const shortSide = Math.min(frame.width, frame.height)
  const style: CSSProperties = {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    fontSize: `${(17 / shortSide) * (shortSide / frame.width) * 100}cqw`,
  }
  const value = (key: (typeof cardLineKeys)[number]) => line[key]?.trim() ?? ''
  const where = [value('setCode'), value('language')].filter(Boolean).join(' \u2022 ')
  const rarity = value('rarity').toUpperCase().slice(0, 1)
  const foil = (rarity === 'R' || rarity === 'L') && line.foil !== false
  return (
    <div className="card-line" style={style}>
      {/* The holographic stamp of rare and legendary cards, in the middle of the line */}
      {foil && <img className="card-line-foil" src={asset('/icons/foil.png')} alt="" />}
      <span className="card-line-artist">
        {line.code?.trim() ? (
          <span className="card-line-code">{line.code.trim()}</span>
        ) : value('artist') && (
          <>
            <img src={asset('/icons/artist.png')} alt="Artist" />
            {value('artist')}
          </>
        )}
      </span>
      {value('block') && <span className="card-line-block">{value('block').slice(0, 1)}</span>}
      <span className="card-line-gap" />
      {where && <span>{where}</span>}
      {rarityNames[rarity] && (
        <img
          className="card-line-rarity"
          src={asset(`/icons/rarity/${rarity.toLowerCase()}.png`)}
          alt={rarityNames[rarity]}
          title={rarityNames[rarity]}
        />
      )}
      <span className="card-line-number">{value('number')}</span>
    </div>
  )
}

// The picture mirrored across each of its edges and corners, to continue it past them
const mirrors = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => ({ dx, dy })))

// The art behind the frame. At zoom 1 it is just big enough to cover the card, and
// the whole image is kept: what hangs over the card's edge can be moved into view.
// Moved or shrunk far enough, the art no longer reaches every edge of the card. The
// gap is then filled with the picture continued past its own edges, mirrored and
// blurred, and the picture's edges fade into that.
function CardArt(props: { frame: Frame; art: Art }) {
  const { frame, art } = props
  // Width over height, known once the image has loaded
  const [shape, setShape] = useState<{ src: string; ratio: number }>()
  const ratio = shape?.src === art.src ? shape.ratio : undefined
  const cardRatio = frame.width / frame.height
  const wider = ratio !== undefined && ratio > cardRatio
  // The art's size as a share of the card's, and whether that leaves part of the card bare
  const width = (wider ? ratio / cardRatio : 1) * art.zoom
  const height = (ratio === undefined || wider ? 1 : cardRatio / ratio) * art.zoom
  // Turned art is taken to leave a corner bare, rather than working out whether it does
  const rotate = art.rotate ?? 0
  const bare =
    rotate !== 0 ||
    Math.abs(art.x) / 100 > (width - 1) / 2 + 0.001 ||
    Math.abs(art.y) / 100 > (height - 1) / 2 + 0.001
  const fill = ratio !== undefined && bare && art.fill !== false
  const style: CSSProperties = {
    // The art's centre, moved from the card's centre by a share of the card's size
    left: `${50 + art.x}%`,
    top: `${50 + art.y}%`,
    width: wider ? 'auto' : '100%',
    height: ratio === undefined || wider ? '100%' : 'auto',
    aspectRatio: ratio,
    transform: `translate(-50%, -50%) rotate(${rotate}deg) scale(${art.zoom})`,
  }
  // Art in public/art is kept as JPG, but a picture just dropped in is still a PNG
  // until tools/convert_art.py has run: a missing one is looked for as the other
  const [missing, setMissing] = useState<string>()
  const other = art.src.startsWith('/art/') ? art.src.replace(/\.(png|jpe?g|webp)$/i, (ext) => (ext.toLowerCase() === '.jpg' ? '.png' : '.jpg')) : art.src
  const src = asset(missing === art.src ? other : art.src)
  return (
    <div className="card-art" style={style}>
      {fill && (
        <div className="card-art-fill">
          {mirrors.map(({ dx, dy }) => (
            <img
              key={`${dx} ${dy}`}
              src={src}
              alt=""
              style={{
                left: `${dx * 100}%`,
                top: `${dy * 100}%`,
                transform: `scale(${dx === 0 ? 1 : -1}, ${dy === 0 ? 1 : -1})`,
              }}
            />
          ))}
        </div>
      )}
      <img
        className={fill ? 'card-art-faded' : undefined}
        src={src}
        alt=""
        onLoad={(event) =>
          setShape({ src: art.src, ratio: event.currentTarget.naturalWidth / event.currentTarget.naturalHeight })
        }
        onError={() => other !== art.src && missing !== art.src && setMissing(art.src)}
      />
    </div>
  )
}

// Several traits are typed with commas and printed with the dot the cards use
function formatTraits(trait: string) {
  return trait
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' • ')
}

// Browsers draw no text smaller than a set minimum (6px in Chrome), so a card drawn
// small would have its text pushed back up to that size and spill out of its boxes.
// The card is laid out at half its frame's size instead, where the text is well above
// it, and shrunk as a whole to the room it is given. Saved images are drawn from the
// card as laid out, so they come out the same at any size.
function CardScale(props: { frame: Frame; children: ReactNode }) {
  const { frame } = props
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setScale(el.clientWidth / (frame.width / 2))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [frame.width])
  return (
    <div className="card-scale" ref={ref} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
      <div className="card-scale-inner" style={{ transform: scale === null ? undefined : `scale(${scale})`, visibility: scale === null ? 'hidden' : undefined }}>
        {props.children}
      </div>
    </div>
  )
}

// Memoised so typing in the editor only redraws the card being edited
export const CardView = memo(function CardView(props: {
  frame: Frame
  name?: string
  trait?: string
  text?: string
  unique?: boolean
  subtitle?: string
  // Leader side only; left out, the usual Epic Action text is printed, with the cost as its number
  epic?: string
  cost?: number
  power?: number
  hp?: number
  // Pilots only
  pilotText?: string
  upgradePower?: number
  upgradeHp?: number
  // The line along the bottom
  line?: CardLine
  // A Legends card's gold bar
  legends?: boolean
  art?: Art
  look?: Look
  // Parts moved from where the frame has them, as a Prescient leader may be laid out
  layout?: Layout
  // Draw the small copy of the frame: for the frame picker, which shows them all at once
  thumb?: boolean
}) {
  const { frame, name, trait, text, art } = props
  const look = props.look ?? defaultLook
  const shift = (part?: BoxPart) => (props.thumb ? undefined : shiftOf(frame, props.layout, part))
  const unique = isUnique(frame, props.unique)
  const parts = props.thumb ? undefined : frameParts(frame, look)
  const backed = look.panelFill > 0 || look.panelBlur > 0
  // The subtitle bar's inside, around its text
  const subtitlePanel = (box: TextBox) => ({ x: box.x - 4, y: box.y - 2, w: box.w + 8, h: box.h + 4 })
  const cardStyle = {
    '--ink': look.lightText ? '#f6f1e7' : '#17141a',
    '--label-ink': look.lightText ? '#f6f1e7' : '#46464a',
    '--glow': look.lightText ? `rgb(0 0 0 / ${look.textGlow})` : `rgb(255 255 255 / ${look.textGlow})`,
    '--icon-filter': look.lightText ? 'invert(1)' : 'none',
    '--keyword-ink': look.lightText ? '#ff9c8a' : '#8f1714',
    '--epic-ink': look.lightText ? '#f3d27a' : '#7d5a0c',
    // The Piloting box is part of the game text: it fades with the bottom of the frame,
    // unless the game text is kept solid
    '--pilot-box-opacity': look.solidText ? 1 : Math.max(fadeLevels(look).bottom, look.panelFill),
    // With light text the Piloting box turns dark, as the backing behind the panels does
    '--pilot-paper': look.lightText ? '28 23 18' : '226 236 240',
    '--pilot-rim': look.lightText ? '64 56 47' : '243 247 249',
  } as CSSProperties
  return (
    // Without art, the backdrop stands in for it behind the transparent frame
    <CardScale frame={frame}>
      <div className="card card-art-placeholder" style={{ ...cardStyle, width: frame.width / 2 }}>
        {art && <CardArt frame={frame} art={art} />}
        {backed &&
          [
            ...panelParts(frame),
            ...(unique && frame.subtitle && props.subtitle ? [{ box: subtitlePanel(frame.subtitle.box), part: 'name' as const }] : []),
          ].map(({ box: panel, part }, index) => (
            <div
              className="card-panel"
              key={index}
              style={{
                ...shift(part),
                left: `${(panel.x / frame.width) * 100}%`,
                top: `${(panel.y / frame.height) * 100}%`,
                width: `${(panel.w / frame.width) * 100}%`,
                height: `${(panel.h / frame.height) * 100}%`,
                background: `color-mix(in srgb, ${look.lightText ? '#14100c' : frame.paper} ${look.panelFill * 100}%, transparent)`,
                backdropFilter: look.panelBlur > 0 ? `blur(${look.panelBlur * 3}cqw)` : undefined,
              }}
            />
          ))}
        <img
          className="card-frame"
          // Faded in parts, the frame is drawn once more for each part over this copy,
          // which is then only there to give the card its size
          style={{ opacity: parts ? 0 : fadeLevels(look).top }}
          src={asset(props.thumb && frame.thumb ? frame.thumb : frame.src)}
          alt={`${frame.name} frame`}
          width={frame.width}
          height={frame.height}
        />
        {parts?.map(({ clip, mask, src, opacity, part }, index) => (
          <img
            className="card-overlay"
            key={index}
            style={{
              ...shift(part),
              opacity,
              clipPath: clip,
              ...(mask && { maskImage: `url("${mask}")`, maskSize: '100% 100%', WebkitMaskImage: `url("${mask}")`, WebkitMaskSize: '100% 100%' }),
            }}
            src={asset(src ?? frame.src)}
            alt=""
          />
        ))}
        {unique && frame.subtitle?.src && (
          <img
            className="card-overlay"
            style={{ ...shift('name'), opacity: look.solidText ? 1 : fadeLevels(look).top }}
            src={asset(frame.subtitle.src)}
            alt=""
          />
        )}
        {props.legends && legendsBar(frame) && (
          <img className="card-overlay" src={asset(`/templates/legends/${legendsBar(frame)}.png`)} alt="Legends" />
        )}
        {unique && frame.subtitle && props.subtitle && (
          <Shifted shift={shift('name')}>
            <CardText frame={frame} box={frame.subtitle.box} className="card-subtitle" text={props.subtitle} />
          </Shifted>
        )}
        {frame.label && (
          <Shifted shift={shift('label')}>
            <CardText frame={frame} box={frame.label.box} className="card-label" text={frame.label.text} />
          </Shifted>
        )}
        {props.line && !props.thumb && (props.line.code?.trim() || cardLineKeys.some((key) => props.line?.[key]?.trim())) && (
          <CardLine frame={frame} line={props.line} />
        )}
        {numberKinds.map((kind) => {
          const spot = frame[kind]
          const value = props[kind]
          if (!spot || value === undefined) return null
          const signed = kind !== 'cost' && frame.modifiers === true
          return (
            <Shifted key={kind} shift={shift(kind)}>
              <CardNumber frame={frame} kind={kind} spot={spot} value={value} signed={signed} />
            </Shifted>
          )
        })}
        {/* What a pilot gives the unit it is attached to, printed as changes: +2, -1 */}
        {frame.upgradePower && props.upgradePower !== undefined && (
          <Shifted shift={shift('power')}>
            <CardNumber frame={frame} kind="power" spot={frame.upgradePower} value={props.upgradePower} signed />
          </Shifted>
        )}
        {frame.upgradeHp && props.upgradeHp !== undefined && (
          <Shifted shift={shift('hp')}>
            <CardNumber frame={frame} kind="hp" spot={frame.upgradeHp} value={props.upgradeHp} signed />
          </Shifted>
        )}
        <Shifted shift={shift('name')}>
          {name && (
            <CardText
              frame={frame}
              box={frame.nameBox}
              className="card-name"
              text={name}
              unique={unique}
            />
          )}
          {name && frame.nameBox2 && (
            <CardText frame={frame} box={frame.nameBox2} className="card-name" text={name} unique={unique} />
          )}
        </Shifted>
        {trait && (
          <Shifted shift={shift('trait')}>
            <CardText frame={frame} box={frame.traitBox} className="card-trait" text={formatTraits(trait)} />
          </Shifted>
        )}
        <Shifted shift={shift('text')}>
          {frame.pilotBox && !props.thumb ? (
            <PilotArea frame={frame} text={text ?? ''} pilotText={props.pilotText ?? ''} />
          ) : (
            text && frame.textBox && <CardParagraph frame={frame} box={frame.textBox} text={text} />
          )}
        </Shifted>
        <Shifted shift={shift('epic')}>
        {frame.epicBox && !props.thumb && (
          <CardParagraph
            frame={frame}
            box={frame.epicBox}
            className="card-epic"
            text={props.epic ?? epicText(props.cost, frame.deploysAsUpgrade)}
            // The last line stops short of the power and HP printed in the box's corner
            endRoom={frame.deploysAsUpgrade ? 4.6 : 2.4}
          />
        )}
        {frame.stats && (props.power !== undefined || props.hp !== undefined) && (
          <CardStats
            frame={frame}
            spot={frame.stats}
            power={props.power}
            hp={props.hp}
            upgradePower={frame.deploysAsUpgrade ? props.upgradePower : undefined}
            upgradeHp={frame.deploysAsUpgrade ? props.upgradeHp : undefined}
          />
        )}
        </Shifted>
      </div>
    </CardScale>
  )
})
