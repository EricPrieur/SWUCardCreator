import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { asset } from './asset'
import { defaultLook, type Art, type Look } from './cards'
import { canBeUnique, type Frame, type Spot, type TextBox } from './frames'

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

// Cost icons that can be written in game text as [1], [2]...
const costIcons: Record<string, string> = { '1': '/icons/cost-1.png' }

// The game's keywords. In game text they print in bold red capitals, with their number if any.
const keywords = new Set([
  'ambush', 'bounty', 'coordinate', 'exploit', 'grit', 'hidden', 'overwhelm', 'piloting', 'plot', 'raid',
  'restore', 'saboteur', 'sentinel', 'shielded', 'smuggle', 'support',
])
const isKeyword = (text: string) => keywords.has(text.replace(/\s*\d+$/, '').trim().toLowerCase())

// Game text markup, in square brackets: [Hidden] or [Raid 2] prints a keyword in red,
// [1] prints a cost icon, and anything else, like [Action:], prints in bold.
export function GameText(props: { text: string }) {
  const parts = props.text.split(/\[([^\]]+)\]/)
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        if (costIcons[part]) return <img className="cost-icon" key={index} src={asset(costIcons[part])} alt={part} />
        if (isKeyword(part)) {
          return (
            <strong className="keyword" key={index}>
              {/* All capitals, with each word's first letter taller */}
              {part.toUpperCase().split(/(\s+)/).map((word, at) =>
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
        return <strong key={index}>{part}</strong>
      })}
    </>
  )
}

// Game text: wraps inside its box, and the font shrinks until it all fits.
function CardParagraph(props: { frame: Frame; box: TextBox; text: string }) {
  const { frame, box, text } = props
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
    <div className="card-rules" style={style} ref={ref}>
      <p>
        <GameText text={text} />
      </p>
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
  cost?: number
  power?: number
  hp?: number
  art?: Art
  look?: Look
  // Draw the small copy of the frame: for the frame picker, which shows them all at once
  thumb?: boolean
}) {
  const { frame, name, trait, text, art } = props
  const look = props.look ?? defaultLook
  const unique = props.unique === true && canBeUnique(frame)
  const backed = look.panelFill > 0 || look.panelBlur > 0
  const cardStyle = {
    '--ink': look.lightText ? '#f6f1e7' : '#17141a',
    '--label-ink': look.lightText ? '#f6f1e7' : '#46464a',
    '--glow': look.lightText ? `rgb(0 0 0 / ${look.textGlow})` : `rgb(255 255 255 / ${look.textGlow})`,
    '--icon-filter': look.lightText ? 'invert(1)' : 'none',
    '--keyword-ink': look.lightText ? '#ff9c8a' : '#8f1714',
  } as CSSProperties
  return (
    // Without art, the backdrop stands in for it behind the transparent frame
    <div className="card card-art-placeholder" style={cardStyle}>
      {art && (
        <img
          className="card-art"
          src={asset(art.src)}
          alt=""
          style={{ transform: `translate(${art.x}%, ${art.y}%) scale(${art.zoom})` }}
        />
      )}
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
      {unique && frame.subtitle && (
        <img className="card-overlay" style={{ opacity: look.frameOpacity }} src={asset(frame.subtitle.src)} alt="" />
      )}
      {unique && frame.subtitle && props.subtitle && (
        <CardText frame={frame} box={frame.subtitle.box} className="card-subtitle" text={props.subtitle} />
      )}
      {frame.label && <CardText frame={frame} box={frame.label.box} className="card-label" text={frame.label.text} />}
      {numberKinds.map((kind) => {
        const spot = frame[kind]
        const value = props[kind]
        if (!spot || value === undefined) return null
        const signed = kind !== 'cost' && frame.modifiers === true
        return <CardNumber key={kind} frame={frame} kind={kind} spot={spot} value={value} signed={signed} />
      })}
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
      {text && frame.textBox && <CardParagraph frame={frame} box={frame.textBox} text={text} />}
    </div>
  )
})
