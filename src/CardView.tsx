import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { asset } from './asset'
import { cardLineKeys, defaultLook, type Art, type CardLine, type Look } from './cards'
import { aspects, epicText, isUnique, type Frame, type Spot, type TextBox } from './frames'

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
  if (isKeyword(text)) {
    return (
      <strong className="keyword">
        {/* All capitals, with each word's first letter taller */}
        {text.toUpperCase().split(/(\s+)/).map((word, at) =>
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
  // Doubled brackets print the brackets themselves, around an Action's cost:
  // [[Arrow]] is the arrow in brackets, [[1, Arrow]] a resource and the arrow
  const inner = splitBrackets(text)
  if (inner.length === 1 && inner[0].bracketed) {
    return (
      <strong className="action-cost">
        [
        {inner[0].text.split(',').map((item, index) => (
          <span key={index}>
            {index > 0 && ', '}
            {/^\d{1,3}$/.test(item.trim()) ? (
              <InlineCost number={item.trim()} plain={false} />
            ) : isArrow(item) ? (
              <ExhaustIcon />
            ) : (
              item.trim()
            )}
          </span>
        ))}
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
    const text = (filled ?? outlined)?.[1].trim() ?? line
    const className = filled ? 'rule-box rule-box-filled' : outlined ? 'rule-box' : undefined
    return (
      <span className={className} key={index}>
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
// Piloting box, for when the card is played as an upgrade. That box starts with
// PILOTING and what it costs to play that way, and grows upward with its text,
// leaving the unit's text the rest. All of it shrinks together until it fits.
function PilotArea(props: { frame: Frame; text: string; pilotText: string; pilotCost?: number }) {
  const { frame, text, pilotText, pilotCost } = props
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
  }, [text, pilotText, pilotCost, size])

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
        <p hidden={frame.type === 'Leader'}>
          <strong className="keyword">
            P<small>ILOTING</small>
          </strong>{' '}
          <strong className="action-cost">
            [{pilotCost !== undefined && <InlineCost number={String(pilotCost)} plain={false} />}
            {frame.aspects.map((aspect, index) => (
              <img
                className="aspect-icon"
                key={index}
                src={asset(`/icons/aspect/${aspect.toLowerCase()}.png`)}
                alt={aspect}
              />
            ))}
            ]
          </strong>
        </p>
        {pilotText && (
          <p>
            <GameLines text={pilotText} />
          </p>
        )}
      </div>
    </div>
  )
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
  const value = (key: keyof CardLine) => line[key]?.trim() ?? ''
  const where = [value('setCode'), value('language')].filter(Boolean).join(' \u2022 ')
  const rarity = value('rarity').toUpperCase().slice(0, 1)
  return (
    <div className="card-line" style={style}>
      <span className="card-line-artist">
        {value('artist') && (
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
  const src = asset(art.src)
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
  pilotCost?: number
  pilotText?: string
  upgradePower?: number
  upgradeHp?: number
  // The line along the bottom
  line?: CardLine
  art?: Art
  look?: Look
  // Draw the small copy of the frame: for the frame picker, which shows them all at once
  thumb?: boolean
}) {
  const { frame, name, trait, text, art } = props
  const look = props.look ?? defaultLook
  const unique = isUnique(frame, props.unique)
  const backed = look.panelFill > 0 || look.panelBlur > 0
  const cardStyle = {
    '--ink': look.lightText ? '#f6f1e7' : '#17141a',
    '--label-ink': look.lightText ? '#f6f1e7' : '#46464a',
    '--glow': look.lightText ? `rgb(0 0 0 / ${look.textGlow})` : `rgb(255 255 255 / ${look.textGlow})`,
    '--icon-filter': look.lightText ? 'invert(1)' : 'none',
    '--keyword-ink': look.lightText ? '#ff9c8a' : '#8f1714',
    '--epic-ink': look.lightText ? '#f3d27a' : '#7d5a0c',
  } as CSSProperties
  return (
    // Without art, the backdrop stands in for it behind the transparent frame
    <div className="card card-art-placeholder" style={cardStyle}>
      {art && <CardArt frame={frame} art={art} />}
      {backed &&
        frame.panels.map((panel, index) => (
          <div
            className="card-panel"
            key={index}
            style={{
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
        style={{ opacity: look.frameOpacity }}
        src={asset(props.thumb && frame.thumb ? frame.thumb : frame.src)}
        alt={`${frame.name} frame`}
        width={frame.width}
        height={frame.height}
      />
      {unique && frame.subtitle?.src && (
        <img className="card-overlay" style={{ opacity: look.frameOpacity }} src={asset(frame.subtitle.src)} alt="" />
      )}
      {unique && frame.subtitle && props.subtitle && (
        <CardText frame={frame} box={frame.subtitle.box} className="card-subtitle" text={props.subtitle} />
      )}
      {frame.label && <CardText frame={frame} box={frame.label.box} className="card-label" text={frame.label.text} />}
      {props.line && !props.thumb && cardLineKeys.some((key) => props.line?.[key]?.trim()) && (
        <CardLine frame={frame} line={props.line} />
      )}
      {numberKinds.map((kind) => {
        const spot = frame[kind]
        const value = props[kind]
        if (!spot || value === undefined) return null
        const signed = kind !== 'cost' && frame.modifiers === true
        return <CardNumber key={kind} frame={frame} kind={kind} spot={spot} value={value} signed={signed} />
      })}
      {/* What a pilot gives the unit it is attached to, printed as changes: +2, -1 */}
      {frame.upgradePower && props.upgradePower !== undefined && (
        <CardNumber frame={frame} kind="power" spot={frame.upgradePower} value={props.upgradePower} signed />
      )}
      {frame.upgradeHp && props.upgradeHp !== undefined && (
        <CardNumber frame={frame} kind="hp" spot={frame.upgradeHp} value={props.upgradeHp} signed />
      )}
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
      {trait && <CardText frame={frame} box={frame.traitBox} className="card-trait" text={formatTraits(trait)} />}
      {frame.pilotBox && !props.thumb ? (
        <PilotArea frame={frame} text={text ?? ''} pilotText={props.pilotText ?? ''} pilotCost={props.pilotCost} />
      ) : (
        text && frame.textBox && <CardParagraph frame={frame} box={frame.textBox} text={text} />
      )}
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
    </div>
  )
})
