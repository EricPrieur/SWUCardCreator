import { generatedFrames } from './generatedFrames'

export type FrameType = 'Unit' | 'Event' | 'Upgrade' | 'Fortification' | 'Token' | 'Base' | 'Leader'
export const aspects = ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy'] as const
export type Aspect = (typeof aspects)[number]
export type Arena = 'Ground' | 'Space'

// Where text sits on a frame, in the frame image's own pixels; size is the font size.
// Name and trait are centred in their box, game text is left-aligned.
export type TextBox = { x: number; y: number; w: number; h: number; size: number }
// A text panel's inside area, used to back the text when the frame is see-through
export type Box = { x: number; y: number; w: number; h: number }
// Where a number is printed: its centre, and the height of the number image
export type Spot = { x: number; y: number; h: number }

export type Frame = {
  id: string
  name: string
  type: FrameType
  // Empty for a neutral frame; the same aspect twice for a double-aspect frame
  aspects: Aspect[]
  // Units only
  arena?: Arena
  // A token unit: listed with the tokens as well as the units
  token?: boolean
  src: string
  // A small copy of the frame image, for the frame picker
  thumb?: string
  width: number
  height: number
  nameBox: TextBox
  // Upgrades print the name a second time, at the bottom
  nameBox2?: TextBox
  traitBox: TextBox
  panels: Box[]
  // The panels' paper colour
  paper: string
  // Missing on frames with no game text box
  textBox?: TextBox
  // Numbers the frame has an icon for
  cost?: Spot
  power?: Spot
  hp?: Spot
  // The bar a unique unit has under its name: an overlay image, and where its text goes.
  // Leaders are always unique, so their frames have the bar already and need no overlay.
  subtitle?: { src?: string; box: TextBox }
  // A Leader side's Epic Action box, with its own text
  epicBox?: TextBox
  // A leader is one card with two sides. The Leader side names its Leader Unit
  // frame (the Ground one; the Space one's id ends in -space), and those name the
  // Leader side they are the back of.
  backId?: string
  backOf?: string
  // A Leader side prints power and HP small, as 4/7, in the Epic Action box:
  // where that ends on the right, its middle line, and the height of the numbers
  stats?: Spot
  // Upgrades print power and HP as changes: +2, -1
  modifiers?: boolean
  // Type label printed by the site, for frames whose bar was wiped clean
  label?: { text: string; box: TextBox }
  notes?: string
}

// Units and upgrades can be unique, which prints a star before the name
export const canBeUnique = (frame: Frame) =>
  frame.type === 'Unit' || frame.type === 'Upgrade' || frame.type === 'Fortification'
// Every leader is unique
export const isUnique = (frame: Frame, unique?: boolean) =>
  frame.type === 'Leader' || (unique === true && canBeUnique(frame))

// What nearly every leader's Epic Action box says. The number of resources is the
// cost printed on the Leader Unit side.
export const epicText = (cost = 5) =>
  `[Epic Action:] If you control ${cost} or more resources, deploy this leader.`

const tokenNameBox: TextBox = { x: 78, y: 589, w: 344, h: 29, size: 23 }
const tokenTraitBox: TextBox = { x: 78, y: 624, w: 344, h: 29, size: 18 }
const tokenTextBox: TextBox = { x: 42, y: 458, w: 418, h: 99, size: 21 }
const tokenPanels: Box[] = [
  { x: 28, y: 453, w: 445, h: 109 },
  { x: 76, y: 588, w: 349, h: 30 },
  { x: 76, y: 623, w: 349, h: 31 },
]
const greyPaper = '#d3d6d7'
const commandHeroismSubtitle = {
  src: '/templates/unit/command-heroism-subtitle.webp',
  box: { x: 150, y: 112, w: 490, h: 23, size: 19 },
}
const commandVillainySubtitle = {
  ...commandHeroismSubtitle,
  src: '/templates/unit/command-villainy-subtitle.webp',
}

// Bases are landscape cards: one frame per aspect, with or without a game text box
const basePapers: Partial<Record<Aspect, string>> = {
  Vigilance: '#cbddeb',
  Command: '#d0dcd3',
  Aggression: '#e9dad3',
  Cunning: '#ecdec4',
}

const baseFrames: Frame[] = Object.entries(basePapers).flatMap(([aspect, paper]) =>
  [false, true].map((withText) => ({
    id: `base-${aspect.toLowerCase()}${withText ? '-text' : ''}`,
    name: withText ? 'Base with text' : 'Base',
    type: 'Base' as const,
    aspects: [aspect as Aspect],
    src: `/templates/base/${aspect.toLowerCase()}${withText ? '-text' : ''}.webp`,
    width: 1000,
    height: 718,
    nameBox: { x: 180, y: 62, w: 645, h: 46, size: 38 },
    // The bar at the bottom names where the base is
    traitBox: { x: 265, y: 616, w: 470, h: 38, size: 25 },
    textBox: withText ? { x: 58, y: 466, w: 884, h: 120, size: 29 } : undefined,
    panels: [
      { x: 158, y: 58, w: 688, h: 56 },
      { x: 42, y: 612, w: 916, h: 46 },
      ...(withText ? [{ x: 36, y: 456, w: 928, h: 140 }] : []),
    ],
    paper,
    hp: { x: 76, y: 73, h: 50 },
  })),
)

// Double Command units, Ground and Space. These come from a slightly narrower
// scan than the other unit frames, so the top of the frame sits 2 px lower.
const doubleCommandUnits: Frame[] = (['Ground', 'Space'] as const).map((arena) => ({
  id: `unit-command-command${arena === 'Space' ? '-space' : ''}`,
  name: 'Unit',
  type: 'Unit',
  aspects: ['Command', 'Command'],
  src: `/templates/unit/command-command${arena === 'Space' ? '-space' : ''}.webp`,
  width: 716,
  height: 1000,
  nameBox: { x: 122, y: 60, w: 538, h: 50, size: 43 },
  traitBox: { x: 121, y: 635, w: 466, h: 41, size: 27 },
  textBox: { x: 58, y: 700, w: 600, h: 208, size: 31 },
  panels: [
    { x: 119, y: 58, w: 556, h: 53 },
    { x: 118, y: 633, w: 472, h: 44 },
    { x: 41, y: 690, w: 632, h: 227 },
  ],
  paper: '#d0dcd3',
  cost: { x: 74.5, y: 75.5, h: 57 },
  power: { x: 74, y: 638, h: 52 },
  hp: { x: 635.5, y: 638, h: 52 },
  subtitle: {
    src: '/templates/unit/command-command-subtitle.webp',
    box: { x: 150, y: 114, w: 488, h: 23, size: 19 },
  },
  arena,
}))

// Unit frames cut from 718 px wide scans all share one layout: Ground and Space
// versions, and a subtitle bar for unique units. `key` names the image files.
function unitFrames(key: string, aspects: Aspect[], paper: string, ext = 'webp'): Frame[] {
  return (['Ground', 'Space'] as const).map((arena) => ({
    id: `unit-${key}${arena === 'Space' ? '-space' : ''}`,
    name: 'Unit',
    type: 'Unit',
    aspects,
    src: `/templates/unit/${key}${arena === 'Space' ? '-space' : ''}.${ext}`,
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    traitBox: { x: 120, y: 635, w: 468, h: 41, size: 27 },
    textBox: { x: 58, y: 700, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 117, y: 633, w: 474, h: 44 },
      { x: 40, y: 690, w: 634, h: 227 },
    ],
    paper,
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 73.5, y: 638, h: 52 },
    hp: { x: 636.5, y: 638, h: 52 },
    subtitle: { ...commandHeroismSubtitle, src: `/templates/unit/${key}-subtitle.${ext}` },
    arena,
  }))
}

function eventFrame(key: string, aspects: Aspect[], paper: string, ext = 'webp'): Frame {
  return {
    id: `event-${key}`,
    name: 'Event',
    type: 'Event',
    aspects,
    src: `/templates/event/${key}.${ext}`,
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 60, w: 539, h: 47, size: 43 },
    traitBox: { x: 126, y: 118, w: 532, h: 39, size: 26 },
    textBox: { x: 118, y: 196, w: 482, h: 284, size: 31 },
    panels: [
      { x: 118, y: 58, w: 558, h: 51 },
      { x: 124, y: 117, w: 536, h: 41 },
      { x: 89, y: 187, w: 537, h: 301 },
    ],
    paper,
    cost: { x: 72.5, y: 73.5, h: 57 },
  }
}

// Every upgrade frame shares one layout. `key` names the image file.
function upgradeFrame(key: string, aspects: Aspect[], paper: string, ext = 'webp'): Frame {
  return {
    id: `upgrade-${key}`,
    name: 'Upgrade',
    type: 'Upgrade',
    aspects,
    src: `/templates/upgrade/${key}.${ext}`,
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    nameBox2: { x: 124, y: 842, w: 464, h: 40, size: 32 },
    traitBox: { x: 124, y: 893, w: 464, h: 41, size: 27 },
    textBox: { x: 58, y: 584, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 38, y: 570, w: 640, h: 236 },
      { x: 118, y: 840, w: 476, h: 43 },
      { x: 118, y: 891, w: 476, h: 44 },
    ],
    paper,
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 74.5, y: 890, h: 52 },
    hp: { x: 637.5, y: 888, h: 52 },
    modifiers: true,
  }
}

// Fortifications are upgrades that attach to a base: an upgrade without power or
// HP, with the name and trait in a rounded block at the bottom.
function fortificationFrame(key: string, aspects: Aspect[], paper: string, ext = 'webp'): Frame {
  const { power: _power, hp: _hp, modifiers: _modifiers, ...upgrade } = upgradeFrame(key, aspects, paper)
  return {
    ...upgrade,
    id: `fortification-${key}`,
    name: 'Fortification',
    type: 'Fortification',
    src: `/templates/fortification/${key}.${ext}`,
    nameBox2: { x: 114, y: 842, w: 486, h: 40, size: 32 },
    traitBox: { x: 114, y: 893, w: 486, h: 41, size: 27 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 38, y: 570, w: 640, h: 236 },
      { x: 108, y: 840, w: 498, h: 43 },
      { x: 108, y: 891, w: 498, h: 44 },
    ],
  }
}

const fortificationFrames: Frame[] = [
  fortificationFrame('vigilance', ['Vigilance'], '#cbddeb'),
  fortificationFrame('vigilance-command', ['Vigilance', 'Command'], '#cddce1'),
  fortificationFrame('aggression-heroism', ['Aggression', 'Heroism'], '#f3f2f2'),
  fortificationFrame('vigilance-villainy', ['Vigilance', 'Villainy'], '#9bc6dc'),
  fortificationFrame('command-villainy', ['Command', 'Villainy'], '#b6c9bb'),
  fortificationFrame('aggression-villainy', ['Aggression', 'Villainy'], '#d8bdb2'),
  // No card has these: the upgrade frame of the same aspects with a recoloured block
  ...(
    [
      ['neutral', [], '#ced1d3'],
      ['command', ['Command'], '#d0dbd3'],
      ['aggression', ['Aggression'], '#e9dad3'],
      ['cunning', ['Cunning'], '#ecdec4'],
      ['heroism', ['Heroism'], '#f3f2f3'],
      ['villainy', ['Villainy'], '#b6a1ae'],
      ['vigilance-heroism', ['Vigilance', 'Heroism'], '#f3f2f3'],
      ['command-heroism', ['Command', 'Heroism'], '#f2f3f3'],
      ['cunning-heroism', ['Cunning', 'Heroism'], '#f2f3f3'],
      ['cunning-villainy', ['Cunning', 'Villainy'], '#dec99e'],
    ] as [string, Aspect[], string][]
  ).map(([key, aspects, paper]) => ({ ...fortificationFrame(key, aspects, paper), notes: 'Composed' })),
]

// Token units. Without a text box they have their own layout; with one they are
// a unit frame with the icons and trait bar lower and a shorter text box.
const tokenUnitFrames: Frame[] = [
  ...(
    [
      ['token', [], greyPaper],
      ['token-heroism', ['Heroism'], '#f3f3f3'],
      ['token-villainy', ['Villainy'], '#b6a1af'],
    ] as [string, Aspect[], string][]
  ).flatMap(([key, aspects, paper]) =>
    (['Ground', 'Space'] as const).map(
      (arena): Frame => ({
        id: key === 'token' && arena === 'Ground' ? 'token-unit' : `unit-${key}${arena === 'Space' ? '-space' : ''}`,
        name: 'Token Unit',
        token: true,
        type: 'Unit',
        aspects,
        src: `/templates/unit/${key}${arena === 'Space' ? '-space' : ''}.webp`,
        width: 716,
        height: 1000,
        nameBox: { x: 122, y: 62, w: 538, h: 48, size: 42 },
        traitBox: { x: 124, y: 876, w: 464, h: 40, size: 27 },
        panels: [
          { x: 118, y: 60, w: 558, h: 52 },
          { x: 118, y: 874, w: 476, h: 44 },
        ],
        paper,
        cost: { x: 74.5, y: 75.5, h: 57 },
        power: { x: 73.5, y: 878, h: 52 },
        hp: { x: 637.5, y: 878, h: 52 },
        arena,
        notes: 'No game text box.',
      }),
    ),
  ),
  ...(
    [
      ['token-text-neutral', [], '#cfd2d3'],
      ['token-text-vigilance', ['Vigilance'], '#cbddeb'],
    ] as [string, Aspect[], string][]
  ).flatMap(([key, aspects, paper]) =>
    unitFrames(key, aspects, paper).map(
      ({ subtitle: _subtitle, ...frame }): Frame => ({
        ...frame,
        name: 'Token Unit',
        token: true,
        traitBox: { x: 120, y: 715, w: 468, h: 41, size: 27 },
        textBox: { x: 58, y: 786, w: 602, h: 122, size: 31 },
        panels: [
          { x: 118, y: 55, w: 558, h: 53 },
          { x: 117, y: 713, w: 474, h: 44 },
          { x: 40, y: 770, w: 634, h: 147 },
        ],
        power: { x: 73.5, y: 718, h: 52 },
        hp: { x: 636.5, y: 718, h: 52 },
      }),
    ),
  ),
]

// Frames cut from one or two cards each: single aspects, Heroism or Villainy alone, and no aspect
const singleFrames: Frame[] = [
  ...unitFrames('neutral', [], '#ced2d5'),
  ...unitFrames('command', ['Command'], '#d0dbd3'),
  ...unitFrames('heroism', ['Heroism'], '#f3f2f3'),
  ...unitFrames('villainy', ['Villainy'], '#b5a1af'),
  eventFrame('neutral', [], '#ced2d5'),
  eventFrame('vigilance', ['Vigilance'], '#cbddec'),
  eventFrame('command', ['Command'], '#d0dbd3'),
  eventFrame('heroism', ['Heroism'], '#f3f2f3'),
  eventFrame('vigilance-heroism', ['Vigilance', 'Heroism'], '#f3f2f2'),
  eventFrame('command-heroism', ['Command', 'Heroism'], '#f3f3f2'),
  eventFrame('command-villainy', ['Command', 'Villainy'], '#b6c9ba'),
]

const upgradeFrames: Frame[] = [
  upgradeFrame('neutral', [], '#ced1d3'),
  upgradeFrame('vigilance', ['Vigilance'], '#cbddeb'),
  upgradeFrame('command', ['Command'], '#d0dbd3'),
  upgradeFrame('aggression', ['Aggression'], '#e9dad3'),
  upgradeFrame('cunning', ['Cunning'], '#ecdec4'),
  upgradeFrame('heroism', ['Heroism'], '#f3f2f3'),
  upgradeFrame('villainy', ['Villainy'], '#b6a1ae'),
  upgradeFrame('vigilance-vigilance', ['Vigilance', 'Vigilance'], '#cbddeb'),
  upgradeFrame('aggression-aggression', ['Aggression', 'Aggression'], '#e9dad3'),
  upgradeFrame('vigilance-command', ['Vigilance', 'Command'], '#cddce1'),
  upgradeFrame('vigilance-heroism', ['Vigilance', 'Heroism'], '#f3f2f3'),
  upgradeFrame('command-heroism', ['Command', 'Heroism'], '#f2f3f3'),
  upgradeFrame('aggression-heroism', ['Aggression', 'Heroism'], '#f2f2f2'),
  upgradeFrame('cunning-heroism', ['Cunning', 'Heroism'], '#f2f3f3'),
  upgradeFrame('vigilance-villainy', ['Vigilance', 'Villainy'], '#9cc6dc'),
  upgradeFrame('aggression-villainy', ['Aggression', 'Villainy'], '#d8bcb2'),
  upgradeFrame('cunning-villainy', ['Cunning', 'Villainy'], '#dec99e'),
  upgradeFrame('command-villainy', ['Command', 'Villainy'], '#b6c8bb'),
  upgradeFrame('aggression-cunning-villainy', ['Aggression', 'Cunning', 'Villainy'], '#dbc1ac'),
]

const aggressionFrames: Frame[] = [
  ...unitFrames('aggression', ['Aggression'], '#e9dad3'),
  ...unitFrames('aggression-aggression', ['Aggression', 'Aggression'], '#e9dad3'),
  ...unitFrames('aggression-heroism', ['Aggression', 'Heroism'], '#f3f2f2'),
  ...unitFrames('aggression-villainy', ['Aggression', 'Villainy'], '#d8bcb2'),
  eventFrame('aggression', ['Aggression'], '#e9dad3'),
  eventFrame('aggression-aggression', ['Aggression', 'Aggression'], '#e9dad3'),
  eventFrame('aggression-heroism', ['Aggression', 'Heroism'], '#f3f2f2'),
  eventFrame('aggression-villainy', ['Aggression', 'Villainy'], '#d8bcb2'),
]

const cunningFrames: Frame[] = [
  ...unitFrames('cunning', ['Cunning'], '#ecdec4'),
  ...unitFrames('cunning-cunning', ['Cunning', 'Cunning'], '#ecdec4'),
  ...unitFrames('cunning-heroism', ['Cunning', 'Heroism'], '#f3f2f3'),
  ...unitFrames('cunning-villainy', ['Cunning', 'Villainy'], '#dfc99f'),
  eventFrame('cunning', ['Cunning'], '#ecdec4'),
  eventFrame('cunning-cunning', ['Cunning', 'Cunning'], '#ecdec4'),
  eventFrame('cunning-heroism', ['Cunning', 'Heroism'], '#f3f2f3'),
  eventFrame('cunning-villainy', ['Cunning', 'Villainy'], '#dfca9e'),
]

const vigilanceFrames: Frame[] = [
  ...unitFrames('vigilance', ['Vigilance'], '#cbddec'),
  ...unitFrames('vigilance-vigilance', ['Vigilance', 'Vigilance'], '#cbddec'),
  ...unitFrames('vigilance-heroism', ['Vigilance', 'Heroism'], '#f3f2f2'),
  ...unitFrames('vigilance-villainy', ['Vigilance', 'Villainy'], '#9cc6dc'),
  eventFrame('vigilance-vigilance', ['Vigilance', 'Vigilance'], '#cbddeb'),
  eventFrame('vigilance-villainy', ['Vigilance', 'Villainy'], '#9cc6dc'),
]

// Leaders are two-sided: a landscape Leader side, and a portrait Leader Unit side
// laid out like a unit, with the aspect icons on the right
const leaderFrames: Frame[] = (
  [
    ['vigilance-heroism', ['Vigilance', 'Heroism'], '#f3f3f3'],
    ['vigilance-villainy', ['Vigilance', 'Villainy'], '#9cc6dc'],
    ['command-heroism', ['Command', 'Heroism'], '#f3f3f3'],
    ['command-villainy', ['Command', 'Villainy'], '#b6c9ba'],
    ['aggression-heroism', ['Aggression', 'Heroism'], '#f3f3f3'],
    ['aggression-villainy', ['Aggression', 'Villainy'], '#d8bdb2'],
    ['cunning-heroism', ['Cunning', 'Heroism'], '#f3f3f3'],
    ['cunning-villainy', ['Cunning', 'Villainy'], '#dfca9f'],
  ] as [string, Aspect[], string][]
).flatMap(([key, aspects, paper]): Frame[] => {
  const [unit] = unitFrames(key, aspects, paper)
  return [
    {
      id: `leader-${key}`,
      backId: `leader-${key}-unit`,
      name: 'Leader',
      type: 'Leader',
      aspects,
      src: `/templates/leader/${key}.webp`,
      width: 1000,
      height: 718,
      nameBox: { x: 436, y: 60, w: 436, h: 48, size: 43 },
      subtitle: { box: { x: 476, y: 113, w: 366, h: 23, size: 19 } },
      traitBox: { x: 50, y: 589, w: 392, h: 40, size: 27 },
      textBox: { x: 481, y: 165, w: 392, h: 316, size: 31 },
      epicBox: { x: 481, y: 506, w: 413, h: 112, size: 31 },
      stats: { x: 893, y: 599, h: 27 },
      panels: [
        { x: 429, y: 60, w: 450, h: 49 },
        { x: 468, y: 113, w: 382, h: 23 },
        { x: 465, y: 157, w: 446, h: 472 },
        { x: 44, y: 589, w: 404, h: 40 },
      ],
      paper,
    },
    // The Leader Unit side, as a Ground unit and as a Space unit
    ...(['Ground', 'Space'] as const).map(
      (arena): Frame => ({
        ...unit,
        id: `leader-${key}-unit${arena === 'Space' ? '-space' : ''}`,
        backOf: `leader-${key}`,
        name: 'Leader Unit',
        type: 'Leader',
        arena,
        src: `/templates/leader/${key}-unit${arena === 'Space' ? '-space' : ''}.webp`,
        // The name panel stops short of the aspect icon on its right
        nameBox: { x: 121, y: 57, w: 474, h: 50, size: 43 },
        subtitle: { box: { x: 152, y: 112, w: 408, h: 23, size: 19 } },
        panels: [{ x: 117, y: 57, w: 482, h: 51 }, { x: 149, y: 112, w: 415, h: 23 }, ...unit.panels.slice(1)],
      }),
    ),
  ]
})

// Combinations no extracted card has, composed from the frames above by tools/compose_frames.py
const composedFrames: Frame[] = generatedFrames.flatMap(({ type, key, aspects, paper }) => {
  const made =
    type === 'unit'
      ? unitFrames(key, [...aspects], paper, 'webp')
      : [
          (type === 'event' ? eventFrame : type === 'upgrade' ? upgradeFrame : fortificationFrame)(
            key,
            [...aspects],
            paper,
            'webp',
          ),
        ]
  return made.map((frame) => ({ ...frame, notes: 'Composed' }))
})

// Frames are transparent where the art goes. Rebuild them with tools/extract_frames.py.
const allFrames: Frame[] = [
  {
    id: 'spice-token',
    name: 'Spice Token',
    type: 'Token',
    aspects: [],
    src: '/templates/token/spice.webp',
    width: 501,
    height: 700,
    nameBox: tokenNameBox,
    traitBox: tokenTraitBox,
    textBox: tokenTextBox,
    panels: tokenPanels,
    paper: greyPaper,
    label: { text: 'Spice Token', box: { x: 58, y: 24.5, w: 206, h: 14, size: 13.5 } },
    notes: 'The Credit Token frame, relabelled. No stats.',
  },
  {
    id: 'unit-command-heroism',
    name: 'Unit',
    type: 'Unit',
    aspects: ['Command', 'Heroism'],
    src: '/templates/unit/command-heroism.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    traitBox: { x: 120, y: 635, w: 468, h: 41, size: 27 },
    textBox: { x: 58, y: 700, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 117, y: 633, w: 474, h: 44 },
      { x: 40, y: 690, w: 634, h: 227 },
    ],
    paper: '#f1f1ef',
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 73.5, y: 638, h: 52 },
    hp: { x: 636.5, y: 638, h: 52 },
    subtitle: commandHeroismSubtitle,
    arena: 'Ground',
  },
  {
    id: 'unit-command-heroism-space',
    name: 'Unit',
    type: 'Unit',
    aspects: ['Command', 'Heroism'],
    src: '/templates/unit/command-heroism-space.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    traitBox: { x: 120, y: 635, w: 468, h: 41, size: 27 },
    textBox: { x: 58, y: 700, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 117, y: 633, w: 474, h: 44 },
      { x: 40, y: 690, w: 634, h: 227 },
    ],
    paper: '#f1f1ef',
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 73.5, y: 638, h: 52 },
    hp: { x: 636.5, y: 638, h: 52 },
    subtitle: commandHeroismSubtitle,
    arena: 'Space',
  },
  {
    id: 'unit-command-villainy',
    name: 'Unit',
    type: 'Unit',
    aspects: ['Command', 'Villainy'],
    src: '/templates/unit/command-villainy.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    traitBox: { x: 120, y: 635, w: 468, h: 41, size: 27 },
    textBox: { x: 58, y: 700, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 117, y: 633, w: 474, h: 44 },
      { x: 40, y: 690, w: 634, h: 227 },
    ],
    paper: '#b9cbbc',
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 73.5, y: 638, h: 52 },
    hp: { x: 636.5, y: 638, h: 52 },
    subtitle: commandVillainySubtitle,
    arena: 'Ground',
  },
  {
    id: 'unit-command-villainy-space',
    name: 'Unit',
    type: 'Unit',
    aspects: ['Command', 'Villainy'],
    src: '/templates/unit/command-villainy-space.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 57, w: 539, h: 50, size: 43 },
    traitBox: { x: 120, y: 635, w: 468, h: 41, size: 27 },
    textBox: { x: 58, y: 700, w: 602, h: 208, size: 31 },
    panels: [
      { x: 118, y: 55, w: 558, h: 53 },
      { x: 117, y: 633, w: 474, h: 44 },
      { x: 40, y: 690, w: 634, h: 227 },
    ],
    paper: '#b9cbbc',
    cost: { x: 72.5, y: 73.5, h: 57 },
    power: { x: 73.5, y: 638, h: 52 },
    hp: { x: 636.5, y: 638, h: 52 },
    subtitle: commandVillainySubtitle,
    arena: 'Space',
  },
  ...doubleCommandUnits,
  ...tokenUnitFrames,
  {
    id: 'event-villainy',
    name: 'Event',
    type: 'Event',
    aspects: ['Villainy'],
    src: '/templates/event/villainy.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 60, w: 539, h: 47, size: 43 },
    traitBox: { x: 126, y: 118, w: 532, h: 39, size: 26 },
    panels: [
      { x: 118, y: 58, w: 558, h: 51 },
      { x: 124, y: 117, w: 536, h: 41 },
      { x: 89, y: 187, w: 537, h: 301 },
    ],
    paper: '#b7a2b1',
    textBox: { x: 118, y: 196, w: 482, h: 284, size: 31 },
    cost: { x: 72.5, y: 73.5, h: 57 },
  },
  {
    id: 'event-command-command',
    name: 'Event',
    type: 'Event',
    aspects: ['Command', 'Command'],
    src: '/templates/event/command-command.webp',
    width: 718,
    height: 1000,
    nameBox: { x: 121, y: 60, w: 539, h: 47, size: 43 },
    traitBox: { x: 126, y: 118, w: 532, h: 39, size: 26 },
    panels: [
      { x: 118, y: 58, w: 558, h: 51 },
      { x: 124, y: 117, w: 536, h: 41 },
      { x: 89, y: 187, w: 537, h: 301 },
    ],
    paper: '#d0dcd3',
    textBox: { x: 118, y: 196, w: 482, h: 284, size: 31 },
    cost: { x: 72.5, y: 73.5, h: 57 },
  },
  {
    id: 'token-upgrade',
    name: 'Token Upgrade',
    type: 'Token',
    aspects: [],
    src: '/templates/token/upgrade.webp',
    width: 716,
    height: 1000,
    nameBox: { x: 122, y: 842, w: 468, h: 39, size: 33 },
    traitBox: { x: 122, y: 893, w: 468, h: 40, size: 27 },
    panels: [
      { x: 42, y: 646, w: 632, h: 156 },
      { x: 118, y: 841, w: 476, h: 41 },
      { x: 118, y: 892, w: 476, h: 42 },
    ],
    paper: greyPaper,
    textBox: { x: 60, y: 654, w: 596, h: 142, size: 31 },
    cost: { x: 74.5, y: 75.5, h: 57 },
    power: { x: 74.5, y: 886, h: 52 },
    hp: { x: 637.5, y: 886, h: 52 },
    modifiers: true,
  },
  {
    id: 'credit-token',
    name: 'Credit Token',
    type: 'Token',
    aspects: [],
    src: '/templates/token/credit.webp',
    width: 501,
    height: 700,
    nameBox: tokenNameBox,
    traitBox: tokenTraitBox,
    textBox: tokenTextBox,
    panels: tokenPanels,
    paper: greyPaper,
    notes: 'No stats.',
  },
  ...vigilanceFrames,
  ...aggressionFrames,
  ...cunningFrames,
  ...singleFrames,
  ...upgradeFrames,
  ...fortificationFrames,
  ...leaderFrames,
  ...composedFrames,
  ...baseFrames,
]

export const frames: Frame[] = allFrames.map((frame) => ({
  ...frame,
  thumb: frame.src.replace('/templates/', '/templates/thumb/'),
}))
