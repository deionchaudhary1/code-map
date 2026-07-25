import { useRef, useState, type DragEvent } from "react";
import type { SessionResponse } from "../types";
import { cloneRepo, uploadZip, humanFileSize } from "../api";

interface UploadScreenProps {
  maxUploadBytes: number;
  onReady: (session: SessionResponse) => void;
}

type Busy = { kind: "upload"; name: string } | { kind: "clone"; url: string } | null;

export default function UploadScreen({ maxUploadBytes, onReady }: UploadScreenProps) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function run<T>(next: Busy, work: () => Promise<SessionResponse>) {
    setBusy(next);
    setError(null);
    try {
      onReady(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(null);
    }
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please choose a .zip file.");
      return;
    }
    // Checked here as well as server-side so an oversized file fails instantly
    // instead of after uploading the whole thing.
    if (file.size > maxUploadBytes) {
      setError(`That zip is ${humanFileSize(file.size)}; the limit is ${humanFileSize(maxUploadBytes)}.`);
      return;
    }
    void run({ kind: "upload", name: file.name }, () => uploadZip(file));
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    handleFile(e.dataTransfer.files[0]);
  }

  function handleClone(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    void run({ kind: "clone", url: trimmed }, () => cloneRepo(trimmed));
  }

  if (busy) {
    return (
      <div className="upload-screen">
        <div className="upload-card">
          <div className="spinner" />
          <h1>{busy.kind === "upload" ? "Analyzing your project" : "Cloning and analyzing"}</h1>
          <p className="upload-sub mono">{busy.kind === "upload" ? busy.name : busy.url}</p>
          <p className="hint">
            Parsing every source file and resolving imports. Large projects take a few seconds.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <h1>code-map</h1>
        <p className="upload-sub">
          See how a JavaScript or TypeScript codebase is actually wired together.
        </p>

        <form className="clone-form" onSubmit={handleClone}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            spellCheck={false}
            aria-label="Public GitHub repository URL"
          />
          <button type="submit" className="toggle-btn active" disabled={!url.trim()}>
            Analyze
          </button>
        </form>
        <p className="hint">Public GitHub repositories only.</p>

        <div className="or-divider">
          <span>or</span>
        </div>

        <div
          className={dragging ? "dropzone dragging" : "dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
          }}
        >
          <strong>Drop a .zip of your project</strong>
          <span>or click to choose one — up to {humanFileSize(maxUploadBytes)}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        {error && <div className="explain-error">{error}</div>}

        <p className="hint upload-footer">
          Your code is analyzed statically, never executed, and deleted automatically when your
          session expires.
        </p>
      </div>
    </div>
  );
}
