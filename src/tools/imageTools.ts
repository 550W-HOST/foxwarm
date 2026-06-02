import fs from 'fs-extra';
import path from 'path';
import {
    ToolArgs,
    ToolContext,
    resolveAgentPath,
    shouldEnforceIsolatedMasterPathAccess,
} from './helpers';
import { checkPathAccess } from '../isolatedCheck';
import { cropImageById, resolveImageById } from '../toolImages';
import { nodesManager } from '../nodes/manager';

export async function tool_image_crop(args: ToolArgs, ctx: ToolContext) {
    const { id, x, y, width, height } = args;

    if (!ctx.sessionId) {
        throw new Error('image_crop requires an active session context.');
    }
    if (!id || typeof id !== 'string') {
        throw new Error('image_crop requires id.');
    }

    const cropped = await cropImageById(ctx.sessionId, id, {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
    });

    return {
        output: `[Cropped image from ${id}]`,
        sourceImageId: id,
        crop: {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
        },
        mimeType: cropped.imageMeta.mimeType,
        sizeBytes: cropped.imageMeta.sizeBytes,
        inlineData: cropped.inlineData,
    };
}

export async function tool_image_write_to_file(args: ToolArgs, ctx: ToolContext) {
    const { id, filePath, overwrite = false } = args;

    if (!ctx.sessionId) {
        throw new Error('image_write_to_file requires an active session context.');
    }
    if (!id || typeof id !== 'string') {
        throw new Error('image_write_to_file requires id.');
    }
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('image_write_to_file requires filePath.');
    }

    const sessionId = ctx.sessionId;
    const currentNode = ctx.runtimeNodeId
        || ctx.session?.currentNode
        || await nodesManager.getCurrentNode(sessionId)
        || 'master';
    const targetNode = currentNode;
    const resolved = await resolveImageById(sessionId, id);

    if (targetNode === 'master') {
        const agentName = ctx.session?.agent || 'main';
        const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
        if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
            checkPathAccess(fullPath, agentName);
        }
        const exists = await fs.pathExists(fullPath);
        if (exists && overwrite !== true) {
            throw new Error(`File already exists: ${filePath}. Use overwrite=true to overwrite.`);
        }
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, resolved.buffer);
    } else {
        await nodesManager.writeFileToNode(targetNode, filePath, resolved.buffer.toString('base64'), overwrite === true, sessionId);
    }

    return [
        `Image \`${id}\` written to \`${filePath}\` on node \`${targetNode}\`.`,
        'You can send it with send_file({ filePath: "' + filePath + '"' + (targetNode !== 'master' ? ', node: "' + targetNode + '"' : '') + ' }).',
    ].join('\n');
}
