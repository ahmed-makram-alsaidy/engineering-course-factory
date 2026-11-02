// Quick file switcher (Ctrl+P): minimal, non-destructive.
import { useEffect, useRef, useState } from "react";

interface Props {
  files: readonly string[];
  onPick(path: string): void;
  onClose(): void;
}

export function QuickSwitcher(props: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = props.files.filter((file) => file.toLowerCase().includes(query.toLowerCase())).slice(0, 12);

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="switcher" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="go to file…"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") {
              const hit = matches[selected];
              if (hit) props.onPick(hit);
            }
            if (event.key === "ArrowDown") setSelected((current) => Math.min(current + 1, matches.length - 1));
            if (event.key === "ArrowUp") setSelected((current) => Math.max(current - 1, 0));
          }}
        />
        <ul>
          {matches.map((file, index) => (
            <li
              key={file}
              className={index === selected ? "selected" : ""}
              onClick={() => props.onPick(file)}
            >
              {file}
            </li>
          ))}
          {matches.length === 0 && <li>no matches</li>}
        </ul>
      </div>
    </div>
  );
}
