/**
 * GoTestBDS — Script API side of the end-to-end testing SDK.
 *
 * The addon is both the test runner and the oracle: it drives headless bot
 * clients over chat (this module) and asserts against the world using the
 * Script API directly. See README.md for the wire protocol.
 */

export { Bot, type ScreenshotOptions } from "./bot";
export {
  cancelAllInstructions,
  DEFAULT_ACTION_TIMEOUT_MS,
  InstructionError,
  runAction,
  runActionForData,
  type RunActionOptions,
} from "./client";
export {
  ConsoleReporter,
  MultiReporter,
  type Reporter,
  type RunResult,
  type RunTotals,
  STRUCTURED_LOG_PREFIX,
  type StructuredEvent,
  type StructuredEventKind,
  StructuredReporter,
  type SuiteResult,
  type TestResult,
  type TestStatus,
} from "./reporter";
export {
  decodeStatus,
  decodeStatusPart,
  encodeInstruction,
  INSTRUCTION_PREFIX,
  type InstructionEnvelope,
  type InstructionStatusKind,
  msToTicks,
  STATUS_PART_PREFIX,
  STATUS_PREFIX,
  type StatusEnvelope,
  type StatusPart,
} from "./protocol";
export {
  defineSuite,
  type RunOptions,
  runSuites,
  type TestCase,
  type TestContext,
  type TestFilter,
  type TestSuite,
} from "./runner";
export {
  assert,
  AssertionError,
  assertBlockAt,
  assertContains,
  assertDefined,
  assertEquals,
  assertEventually,
  assertInRange,
  assertNearPosition,
  assertThrows,
} from "./assert";
export {
  retry,
  seconds,
  sleep,
  ticks,
  TimeoutError,
  waitFor,
  waitForValue,
  type WaitOptions,
} from "./wait";
export type {
  BlockAtPosition,
  BotInventory,
  BotItemStack,
  BotState,
  ClickedFormButton,
  Face,
  FormButtonContent,
  FormElementContent,
  MovementInput,
  NearbyEntities,
  NearbyEntity,
  OpenForm,
  Pos,
  PullArtifactsResult,
  ReceivedMessage,
  ReceivedMessages,
  Rotation,
  ScreenshotResult,
  TestArtifact,
  Vec3,
  ViewerMarkParams,
} from "./types";
export type {
  InstructionAction,
  InstructionParametersByAction,
} from "./__generated__/types";
