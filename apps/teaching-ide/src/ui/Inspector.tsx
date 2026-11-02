// Development-only IR inspector (hidden in recording-safe mode): the selected
// step in full detail — provenance, narration, operation descriptor, and the
// raw operation JSON. Inspection only; nothing here acts on the data.
import { compileOperationDescriptor, NOT_EXECUTED_NOTE } from "../model/operation-display.ts";
import type { CompiledLesson } from "../model/ir.ts";
import type { PlayheadState } from "../model/playhead.ts";

interface Props {
  lesson: CompiledLesson | null;
  playhead: PlayheadState;
}

export function Inspector(props: Props): React.JSX.Element {
  const lesson = props.lesson;
  if (!lesson) {
    return (
      <section className="panel inspector" aria-label="IR inspector">
        <div className="panel-header">IR inspector</div>
        <div className="panel-body pad">
          <div className="loading">no lesson loaded</div>
        </div>
      </section>
    );
  }
  const scene = lesson.scenes[props.playhead.sceneIndex];
  const step = scene.steps[props.playhead.stepIndex];

  return (
    <section className="panel inspector" aria-label="IR inspector">
      <div className="panel-header">IR inspector — {step.step_id}</div>
      <div className="panel-body pad">
        <div className="kv">
          <span className="k">scene</span>
          <span className="v">{scene.scene_id} (#{scene.ordinal})</span>
          <span className="k">scene type</span>
          <span className="v">{scene.type}</span>
          <span className="k">narration form</span>
          <span className="v">{scene.narration_form}</span>
          <span className="k">kind</span>
          <span className="v">{step.kind}</span>
          <span className="k">derived</span>
          <span className="v">{step.derived ? "yes (compiler-synthesized)" : "no (authored beat)"}</span>
          <span className="k">form</span>
          <span className="v">{step.source_ref.form}</span>
          <span className="k">beat</span>
          <span className="v">{step.source_ref.beat_id ?? "—"}</span>
        </div>

        {step.kind === "narration" && (
          <>
            <div className="list-heading">Narration</div>
            <div className="narration-quote">{step.narration.text}</div>
            <div className="kv">
              <span className="k">language</span>
              <span className="v">{step.narration.language}</span>
              <span className="k">direction</span>
              <span className="v">{step.narration.direction}</span>
              {step.narration.speaker && (
                <>
                  <span className="k">speaker</span>
                  <span className="v">{step.narration.speaker}</span>
                </>
              )}
              {step.narration.delivery && (
                <>
                  <span className="k">delivery</span>
                  <span className="v">{step.narration.delivery}</span>
                </>
              )}
            </div>
          </>
        )}

        {step.kind === "pause" && (
          <div className="kv">
            <span className="k">seconds</span>
            <span className="v">{step.seconds}</span>
          </div>
        )}

        {step.kind === "operation" && (
          <>
            <div className="list-heading">Operation</div>
            <div className="op-meta">
              <span className="k">type</span>
              <span className="v">{step.operation.type}</span>
              <span className="k">family</span>
              <span className="v">{step.operation.family}</span>
              {compileOperationDescriptor(step.operation).meta.map(([key, value]) => (
                <span key={key} style={{ display: "contents" }}>
                  <span className="k">{key}</span>
                  <span className="v">{value}</span>
                </span>
              ))}
            </div>
            <div className="note">⚠ {NOT_EXECUTED_NOTE}</div>
            <div className="list-heading">Raw parameters</div>
            <pre className="raw">{JSON.stringify(step.operation.parameters, null, 2)}</pre>
          </>
        )}
      </div>
    </section>
  );
}
