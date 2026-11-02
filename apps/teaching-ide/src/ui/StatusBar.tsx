// Top status bar: lesson identity, playhead position, current operation,
// recording-safe toggle, and editor font size control.
import { compileOperationDescriptor } from "../model/operation-display.ts";
import type { CompiledLesson, CompiledStep } from "../model/ir.ts";
import type { PlayheadState } from "../model/playhead.ts";

interface Props {
  lesson: CompiledLesson | null;
  playhead: PlayheadState;
  currentStep: CompiledStep | null;
  recordingSafe: boolean;
  onToggleRecordingSafe(): void;
  fontSize: number;
  onFontSize(delta: number): void;
  devBadgeVisible: boolean;
  fixtureSelectorVisible: boolean;
  fixtureId: string | null;
  onCycleFixture(): void;
  runtimeState?: string;
  runtimeEngine?: string;
}

export function StatusBar(props: Props): React.JSX.Element {
  const lesson = props.lesson;
  const operation =
    props.currentStep?.kind === "operation" ? compileOperationDescriptor(props.currentStep.operation) : null;
  const scene = lesson ? lesson.scenes[props.playhead.sceneIndex] : null;

  return (
    <header className="statusbar">
      <span className="title">Course Factory — Teaching IDE</span>
      <span className="crumb">
        {lesson ? (
          <>
            Course <b>{lesson.lesson.course_id}</b> · Lesson <b>{lesson.lesson.lesson_id}</b> · Scene{" "}
            <b>{scene?.scene_id}</b>
          </>
        ) : (
          "no lesson loaded"
        )}
      </span>
      {operation && <span className="chip op">{operation.title}</span>}
      <span className="chip op">{scene?.type ?? "—"}</span>
      {props.runtimeState && (
        <span className={`chip status-${props.runtimeState.toLowerCase()}`} title="Runtime State">
          {props.runtimeState}
        </span>
      )}
      {props.runtimeEngine && (
        <span className="chip engine-badge" title="Active Engine">
          {props.runtimeEngine}
        </span>
      )}
      <span className="spacer" />
      {props.devBadgeVisible && <span className="dev-badge">DEV</span>}
      {props.fixtureSelectorVisible && (
        <button className="ui" onClick={props.onCycleFixture} title="Cycle bundled compiled-lesson fixture">
          fixture: {props.fixtureId}
        </button>
      )}
      <span className="fontsize">
        font
        <button className="ui" onClick={() => props.onFontSize(-1)} aria-label="Decrease editor font size">
          −
        </button>
        <span>{props.fontSize}px</span>
        <button className="ui" onClick={() => props.onFontSize(+1)} aria-label="Increase editor font size">
          +
        </button>
      </span>
      <button className={`ui ${props.recordingSafe ? "accent" : ""}`} onClick={props.onToggleRecordingSafe}>
        RECORD SAFE: {props.recordingSafe ? "ON" : "OFF"}
      </button>
    </header>
  );
}
