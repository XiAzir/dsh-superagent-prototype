"""Add opt-in, request-scoped QQ upload progress to the pinned SnowLuma bundle."""
from __future__ import annotations

import hashlib
from pathlib import Path

MARKER = '// superagent-upload-progress-v1'

HELPERS = r'''// superagent-upload-progress-v1
import { AsyncLocalStorage as SuperagentUploadStorage } from "node:async_hooks";
const superagentUploadContext = new SuperagentUploadStorage();
async function superagentReportUpload(uploadedBytes, totalBytes, phase = "uploading") {
    const context = superagentUploadContext.getStore();
    if (!context) return;
    await context.send({ type: "upload_progress", uploaded_bytes: uploadedBytes, total_bytes: totalBytes, phase });
}
async function superagentWithUploadProgress(action, params, echo, emit, isAlive, run) {
    if (action === "get_version_info") {
        const response = await run();
        if (response.status === "ok") response.data = { ...response.data, superagent_upload_progress: 1 };
        return response;
    }
    if (params.superagent_progress !== true || !["upload_private_file", "upload_group_file"].includes(action)) return run();
    let latest = -1, lastAt = 0, lastPhase = "";
    return superagentUploadContext.run({ send: async data => {
        if (isAlive && !isAlive()) return;
        if (data.phase === lastPhase && data.uploaded_bytes === latest) return;
        if (data.phase === lastPhase && data.uploaded_bytes < data.total_bytes && Date.now() - lastAt < 500) return;
        latest = data.uploaded_bytes; lastAt = Date.now(); lastPhase = data.phase;
        await emit(JSON.stringify({ status: "async", retcode: 0, data, ...(echo === undefined ? {} : { echo }) }));
    } }, run);
}
'''

REPLACEMENTS = (
    ('\t\tif (!this.isStreamAction(action)) {\n\t\t\tconst response = await this.handle(action, params);',
     '\t\tif (!this.isStreamAction(action)) {\n\t\t\tconst response = await superagentWithUploadProgress(action, params, echo, emit, isAlive, () => this.handle(action, params));'),
    ('\tconst totalSize = source.size;\n\tconst pathStr =',
     '\tconst totalSize = source.size;\n\tawait superagentReportUpload(0, totalSize);\n\tconst pathStr ='),
    ('\t\ttrace.uploadedBytes += chunkSize;\n\t\tconfirmed.add(piece);',
     '\t\ttrace.uploadedBytes += chunkSize;\n\t\tawait superagentReportUpload(trace.uploadedBytes, totalSize);\n\t\tconfirmed.add(piece);'),
    ('\t\t\t\tawait ctx.sendPrivateMessage(p.user_id, [{\n\t\t\t\t\ttype: "file",',
     '\t\t\t\tawait superagentReportUpload(uploaded.fileSize, uploaded.fileSize, "sending");\n\t\t\t\tawait ctx.sendPrivateMessage(p.user_id, [{\n\t\t\t\t\ttype: "file",'),
)


def patch_bundle(source: str) -> str:
    """Apply exact anchors once; normal OneBot calls retain their original response."""
    if source.startswith(MARKER + '\n'):
        return source
    for old, new in REPLACEMENTS:
        if source.count(old) != 1:
            raise ValueError('SnowLuma upload progress patch does not match the selected runtime.')
        source = source.replace(old, new, 1)
    return HELPERS + source


def prepare_bundle(path: Path, original: str) -> str:
    """Publish a complete patched bundle for a read-only container mount."""
    patched = patch_bundle(original)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(patched, encoding='utf-8', newline='\n')
    temporary.chmod(0o644)
    temporary.replace(path)
    return hashlib.sha256(patched.encode()).hexdigest()
