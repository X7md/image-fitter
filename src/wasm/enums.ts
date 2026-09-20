// Numeric enums copied verbatim from the ImageMagick 7.1.2-31 headers that the wasm
// artifact was compiled from (`wasm/ImageMagick/MagickCore/*.h`).
//
// Every value below was read out of the header, not guessed. The header and the line
// where the enum starts are quoted above each block so the next person can re-check it
// with one grep. Plain C enums with no explicit initialisers are numbered from 0 in
// declaration order; `ExceptionType` is the one enum here that uses explicit numbers,
// so its members are copied literally rather than counted.
//
// NOTE (contract deviation): ARCHITECTURE.md §3 says `AlphaChannelOption` lives in
// `MagickCore/image.h`. In 7.1.2 it is actually declared in `MagickCore/channel.h:28`.
// The values are as listed there.

/** MagickCore/resample.h:34 — `UndefinedFilter` .. `SentinelFilter`, contiguous from 0. */
export const FilterType = {
  Undefined: 0,
  Point: 1,
  Box: 2,
  Triangle: 3,
  Hermite: 4,
  Hann: 5,
  Hamming: 6,
  Blackman: 7,
  Gaussian: 8,
  Quadratic: 9,
  Cubic: 10,
  Catrom: 11,
  Mitchell: 12,
  Jinc: 13,
  Sinc: 14,
  SincFast: 15,
  Kaiser: 16,
  Welch: 17,
  Parzen: 18,
  Bohman: 19,
  Bartlett: 20,
  Lagrange: 21,
  Lanczos: 22,
  LanczosSharp: 23,
  Lanczos2: 24,
  Lanczos2Sharp: 25,
  Robidoux: 26,
  RobidouxSharp: 27,
  Cosine: 28,
  Spline: 29,
  LanczosRadius: 30,
  CubicSpline: 31,
  MagicKernelSharp2013: 32,
  MagicKernelSharp2021: 33,
  Sentinel: 34,
} as const
export type FilterType = (typeof FilterType)[keyof typeof FilterType]

/** MagickCore/composite.h:27 — `UndefinedCompositeOp` .. `DivideCompositeOp`, contiguous from 0. */
export const CompositeOperator = {
  Undefined: 0,
  Alpha: 1,
  Atop: 2,
  Blend: 3,
  Blur: 4,
  Bumpmap: 5,
  ChangeMask: 6,
  Clear: 7,
  ColorBurn: 8,
  ColorDodge: 9,
  Colorize: 10,
  CopyBlack: 11,
  CopyBlue: 12,
  Copy: 13,
  CopyCyan: 14,
  CopyGreen: 15,
  CopyMagenta: 16,
  CopyAlpha: 17,
  CopyRed: 18,
  CopyYellow: 19,
  Darken: 20,
  DarkenIntensity: 21,
  Difference: 22,
  Displace: 23,
  Dissolve: 24,
  Distort: 25,
  DivideDst: 26,
  DivideSrc: 27,
  DstAtop: 28,
  Dst: 29,
  DstIn: 30,
  DstOut: 31,
  DstOver: 32,
  Exclusion: 33,
  HardLight: 34,
  HardMix: 35,
  Hue: 36,
  In: 37,
  Intensity: 38,
  Lighten: 39,
  LightenIntensity: 40,
  LinearBurn: 41,
  LinearDodge: 42,
  LinearLight: 43,
  Luminize: 44,
  Mathematics: 45,
  MinusDst: 46,
  MinusSrc: 47,
  Modulate: 48,
  ModulusAdd: 49,
  ModulusSubtract: 50,
  Multiply: 51,
  No: 52,
  Out: 53,
  Over: 54,
  Overlay: 55,
  PegtopLight: 56,
  PinLight: 57,
  Plus: 58,
  Replace: 59,
  Saturate: 60,
  Screen: 61,
  SoftLight: 62,
  SrcAtop: 63,
  Src: 64,
  SrcIn: 65,
  SrcOut: 66,
  SrcOver: 67,
  Threshold: 68,
  VividLight: 69,
  Xor: 70,
  Stereo: 71,
  Freeze: 72,
  Interpolate: 73,
  Negate: 74,
  Reflect: 75,
  SoftBurn: 76,
  SoftDodge: 77,
  Stamp: 78,
  RMSE: 79,
  SaliencyBlend: 80,
  SeamlessBlend: 81,
  Divide: 82,
} as const
export type CompositeOperator = (typeof CompositeOperator)[keyof typeof CompositeOperator]

/** MagickCore/pixel.h:156 — `UndefinedPixel` .. `ShortPixel`, contiguous from 0. */
export const StorageType = {
  Undefined: 0,
  Char: 1,
  Double: 2,
  Float: 3,
  Long: 4,
  LongLong: 5,
  Quantum: 6,
  Short: 7,
} as const
export type StorageType = (typeof StorageType)[keyof typeof StorageType]

/** MagickCore/channel.h:28 — `UndefinedAlphaChannel` .. `OffIfOpaqueAlphaChannel`, contiguous from 0. */
export const AlphaChannelOption = {
  Undefined: 0,
  Activate: 1,
  Associate: 2,
  Background: 3,
  Copy: 4,
  Deactivate: 5,
  Discrete: 6,
  Disassociate: 7,
  Extract: 8,
  Off: 9,
  On: 10,
  Opaque: 11,
  Remove: 12,
  Set: 13,
  Shape: 14,
  Transparent: 15,
  OffIfOpaque: 16,
} as const
export type AlphaChannelOption = (typeof AlphaChannelOption)[keyof typeof AlphaChannelOption]

/** MagickCore/resource_.h:27 — `UndefinedResource` .. `ListLengthResource`, contiguous from 0. */
export const ResourceType = {
  Undefined: 0,
  Area: 1,
  Disk: 2,
  File: 3,
  Height: 4,
  Map: 5,
  Memory: 6,
  Thread: 7,
  Throttle: 8,
  Time: 9,
  Width: 10,
  ListLength: 11,
} as const
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType]

/**
 * MagickCore/geometry.h:79 — `UndefinedGravity`/`ForgetGravity` = 0 .. `SouthEastGravity` = 9.
 * (The header writes these with explicit values; copied literally.)
 */
export const GravityType = {
  Undefined: 0,
  Forget: 0,
  NorthWest: 1,
  North: 2,
  NorthEast: 3,
  West: 4,
  Center: 5,
  East: 6,
  SouthWest: 7,
  South: 8,
  SouthEast: 9,
} as const
export type GravityType = (typeof GravityType)[keyof typeof GravityType]

/**
 * MagickCore/exception.h — NOT contiguous: the header assigns explicit numbers
 * (warnings at 3xx, errors at 4xx, fatals at 7xx) and several aliases share a value
 * (`ErrorException` === `ResourceLimitError` === 400). Copied literally.
 */
export const ExceptionType = {
  Undefined: 0,
  Warning: 300,
  ResourceLimitWarning: 300,
  TypeWarning: 305,
  OptionWarning: 310,
  DelegateWarning: 315,
  MissingDelegateWarning: 320,
  CorruptImageWarning: 325,
  FileOpenWarning: 330,
  BlobWarning: 335,
  StreamWarning: 340,
  CacheWarning: 345,
  CoderWarning: 350,
  FilterWarning: 352,
  ModuleWarning: 355,
  DrawWarning: 360,
  ImageWarning: 365,
  WandWarning: 370,
  RandomWarning: 375,
  XServerWarning: 380,
  MonitorWarning: 385,
  RegistryWarning: 390,
  ConfigureWarning: 395,
  PolicyWarning: 399,
  Error: 400,
  ResourceLimitError: 400,
  TypeError: 405,
  OptionError: 410,
  DelegateError: 415,
  MissingDelegateError: 420,
  CorruptImageError: 425,
  FileOpenError: 430,
  BlobError: 435,
  StreamError: 440,
  CacheError: 445,
  CoderError: 450,
  FilterError: 452,
  ModuleError: 455,
  DrawError: 460,
  ImageError: 465,
  WandError: 470,
  RandomError: 475,
  XServerError: 480,
  MonitorError: 485,
  RegistryError: 490,
  ConfigureError: 495,
  PolicyError: 499,
  FatalError: 700,
  ResourceLimitFatalError: 700,
  TypeFatalError: 705,
  OptionFatalError: 710,
  DelegateFatalError: 715,
  MissingDelegateFatalError: 720,
  CorruptImageFatalError: 725,
  FileOpenFatalError: 730,
  BlobFatalError: 735,
  StreamFatalError: 740,
  CacheFatalError: 745,
  CoderFatalError: 750,
  FilterFatalError: 752,
  ModuleFatalError: 755,
  DrawFatalError: 760,
  ImageFatalError: 765,
  WandFatalError: 770,
  RandomFatalError: 775,
  XServerFatalError: 780,
  MonitorFatalError: 785,
  RegistryFatalError: 790,
  ConfigureFatalError: 795,
  PolicyFatalError: 799,
} as const
export type ExceptionType = (typeof ExceptionType)[keyof typeof ExceptionType]

/** MagickCore/magick-type.h — `MagickFalse` = 0, `MagickTrue` = 1. */
export const MagickBoolean = { False: 0, True: 1 } as const

/** Human-readable label for an `ExceptionType` severity, for error messages. */
export function exceptionSeverityName(severity: number): string {
  for (const [name, value] of Object.entries(ExceptionType)) {
    if (value === severity) return name
  }
  return `Exception(${severity})`
}
