import json
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], vad_filter=True)
print(json.dumps([{"start": cue.start, "end": cue.end, "text": cue.text} for cue in segments], ensure_ascii=False))
