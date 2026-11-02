// Lesson context panel: compiled-IR metadata, scene list, step list, and the
// playhead controls. Everything is navigation/inspection only.
import { sceneLabel, stepLabel } from "../model/ir.ts";
import { playheadLabel } from "../model/playhead.ts";
import type { CompiledLesson } from "../model/ir.ts";
import type { PlayheadState } from "../model/playhead.ts";

interface Props {
  lesson: CompiledLesson | null;
  playhead: PlayheadState;
  onPrevious(): void;
  onNext(): void;
  onGoToScene(index: number): void;
  onGoToStep(sceneIndex: number, stepIndex: number): void;
  runtimeState?: string;
  runtimeEngine?: string;
  runtimeGeneration?: number;
  onStartLesson?(): void;
  onPauseLesson?(): void;
  onResumeLesson?(): void;
  onCancelLesson?(): void;
  onResetLesson?(): void;
  canStart?: boolean;
  canPause?: boolean;
  canResume?: boolean;
  canCancel?: boolean;
  canReset?: boolean;
}

export function LessonContext(props: Props): React.JSX.Element {
  const lesson = props.lesson;
  const scene = lesson ? lesson.scenes[props.playhead.sceneIndex] : null;
  const beatId = scene ? scene.steps[props.playhead.stepIndex]?.step_id ?? "—" : "—";

  return (
    <section className="panel" aria-label="Lesson context">
      <div className="panel-header">Lesson context</div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div className="panel-body pad" style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          {lesson && scene ? (
            <>
              <div className="kv">
                <span className="k">Course</span>
                <span className="v">{lesson.lesson.course_id}</span>
                <span className="k">Lesson</span>
                <span className="v">{lesson.lesson.lesson_id}</span>
                <span className="k">Scene</span>
                <span className="v">{scene.scene_id}</span>
                <span className="k">Scene type</span>
                <span className="v">{scene.type}</span>
                <span className="k">Beat</span>
                <span className="v">{beatId}</span>
                <span className="k">Status</span>
                <span className={`v status-${(props.runtimeState ?? "READY").toLowerCase()}`}>
                  {props.runtimeState ?? "READY"}
                </span>
                {props.runtimeEngine && (
                  <>
                    <span className="k">Engine</span>
                    <span className="v">{props.runtimeEngine}</span>
                  </>
                )}
                {typeof props.runtimeGeneration === "number" && props.runtimeGeneration > 0 && (
                  <>
                    <span className="k">Generation</span>
                    <span className="v">{props.runtimeGeneration}</span>
                  </>
                )}
              </div>

              <div className="list-heading">Scenes</div>
              <ul className="scene-list">
                {lesson.scenes.map((sceneItem, sceneIndex) => (
                  <li
                    key={sceneItem.scene_id}
                    className={sceneIndex === props.playhead.sceneIndex ? "active" : ""}
                    onClick={() => props.onGoToScene(sceneIndex)}
                    title={sceneLabel(sceneItem)}
                  >
                    {sceneLabel(sceneItem)}
                  </li>
                ))}
              </ul>

              <div className="list-heading">Steps — {scene.title}</div>
              <ul className="step-list">
                {scene.steps.map((step, stepIndex) => (
                  <li
                    key={step.step_id}
                    className={stepIndex === props.playhead.stepIndex ? "active" : ""}
                    onClick={() => props.onGoToStep(props.playhead.sceneIndex, stepIndex)}
                    title={stepLabel(step)}
                  >
                    {stepLabel(step)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="loading">loading compiled lesson…</div>
          )}
        </div>
        {props.onStartLesson && (
          <div className="runtime-controls" role="toolbar" aria-label="Runtime playback controls">
            <button
              className="ui accent"
              onClick={props.onStartLesson}
              disabled={!props.canStart}
              title="Start lesson execution"
            >
              ▶ Start
            </button>
            <button
              className="ui"
              onClick={props.onPauseLesson}
              disabled={!props.canPause}
              title="Pause lesson execution"
            >
              ⏸ Pause
            </button>
            <button
              className="ui"
              onClick={props.onResumeLesson}
              disabled={!props.canResume}
              title="Resume lesson execution"
            >
              ▶ Resume
            </button>
            <button
              className="ui"
              onClick={props.onCancelLesson}
              disabled={!props.canCancel}
              title="Cancel lesson execution"
            >
              ⏹ Cancel
            </button>
            <button
              className="ui"
              onClick={props.onResetLesson}
              disabled={!props.canReset}
              title="Reset runtime to initial generation"
            >
              ↺ Reset
            </button>
          </div>
        )}
        <div className="playhead-controls">
          <button className="ui" onClick={props.onPrevious} aria-label="Previous beat">
            ◀ Prev beat
          </button>
          <button className="ui accent" onClick={props.onNext} aria-label="Next beat">
            Next beat ▶
          </button>
          <span style={{ alignSelf: "center", color: "var(--text-3)", fontSize: 11.5, marginLeft: "auto" }}>
            {lesson ? playheadLabel(lesson, props.playhead) : "—"}
          </span>
        </div>
      </div>
    </section>
  );
}
