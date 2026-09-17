// 聊天输入框(composer)功能的宿主侧服务。目前承载 "/" 斜杠命令/技能的数据与执行；
// 后续输入类能力(如 "@ " 引用/文件检索、其它输入触发)都加到这里，避免 dshService 继续膨胀。
// 与 DshService 的关系：只复用它的「服务就绪 + 当前会话」能力(结构型依赖，见 ChatInputSession)。
import {
    listCommands as listCommandsRpc,
    listSkills as listSkillsRpc,
    runSessionCommand,
    fetchSessionLogZip as fetchSessionLogZipRpc,
    uploadSessionFile,
    listFileReferences as listFileReferencesRpc,
    listSessionReferenceCandidates as listSessionReferenceCandidatesRpc,
    ExportUnsupportedError,
    type DshCommandDescriptor,
    type DshSkillEntry,
    type SessionLogZip,
} from './dsh';

/** ChatInputService 需要的宿主会话能力(由 DshService 提供)。 */
export interface ChatInputSession {
    ensureRunning(): Promise<boolean>;
    getSession(): Promise<string>;
}

export class ChatInputService {
    constructor(private readonly session: ChatInputSession) {}

    /**
     * 把本地文件上传给当前会话，返回可随 prompt 引用的凭据。
     * 上传失败原样上抛（含上游错误码）；没工作区/服务不可用同样抛错，由调用方回给 UI。
     * @param filePath - 本地文件绝对路径（webview 只给路径，字节由宿主读）。
     * @returns 凭据 id 与文件信息（大小用于就绪态显示）。
     */
    async uploadFile(filePath: string): Promise<{ receiptId: string; name: string; bytes?: number }> {
        if (!(await this.session.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法上传文件');
        }
        const sid = await this.session.getSession();
        const uploaded = await uploadSessionFile(sid, filePath);
        const name = uploaded.file.name ?? filePath.split(/[\/]/).pop() ?? 'file';
        return {
            receiptId: uploaded.receiptId,
            name,
            ...(typeof uploaded.file.bytes === 'number' ? { bytes: uploaded.file.bytes } : {}),
        };
    }

    /**
     * 当前会话可用的斜杠命令目录(commands/list)。
     *
     * 失败返回 `undefined`（**不是空数组**）：两者对界面是两回事 —— 空数组 = 这个会话确实没有命令，
     * 会把「/」菜单清空；`undefined` = 本次没拉到（服务没就绪 / 会话被别的进程占着导致 RPC 失败），
     * 页面应当**保留现有菜单**并稍后重试。原先一律返回 `[]`，一次失败就把菜单清成只剩客户端贡献项。
     */
    async listCommands(): Promise<DshCommandDescriptor[] | undefined> {
        try {
            if (!(await this.session.ensureRunning())) {
                console.warn('[dsh-slash] commands/list: 服务未就绪，跳过');
                return undefined;
            }
            return await listCommandsRpc(await this.session.getSession());
        } catch (e) {
            console.warn(`[dsh-slash] commands/list 失败：${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    }

    /** 当前会话可用的技能(skills/list)。失败返回 `undefined`（含义同 listCommands，原因打日志便于区分端点错与服务无技能）。 */
    async listSkills(): Promise<DshSkillEntry[] | undefined> {
        try {
            if (!(await this.session.ensureRunning())) {
                console.warn('[dsh-slash] skills/list: 服务未就绪，跳过');
                return undefined;
            }
            const skills = await listSkillsRpc(await this.session.getSession());
            console.warn(`[dsh-slash] skills/list ok: ${skills.length} 条${skills[0] ? `，首条 ${skills[0].name}` : ''}`);
            return skills;
        } catch (e) {
            console.warn(`[dsh-slash] skills/list 失败：${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    }

    /**
     * 「@」引用候选：并发拉当前工作区文件/目录 + 可引用会话（按查询串）。任一侧失败降级为空数组。
     * 返回结构直接对应 webview 协议 atCatalog。
     */
    async listAtRefs(query: string): Promise<{
        files: Array<{ path: string; kind: 'file' | 'directory' }>;
        sessions: Array<{ sessionId: string; label: string; sameWorkspace?: boolean; mention: string }>;
    }> {
        try {
            if (!(await this.session.ensureRunning())) {
                return { files: [], sessions: [] };
            }
            const sid = await this.session.getSession();
            const [files, candidates] = await Promise.all([
                listFileReferencesRpc(sid, query),
                listSessionReferenceCandidatesRpc(sid, query),
            ]);
            return {
                files: files.map((f) => ({ path: f.path, kind: f.kind })),
                sessions: candidates
                    .filter((c) => typeof c.mention === 'string' && c.mention.length > 0)
                    .map((c) => ({
                        sessionId: c.sessionId,
                        label: c.label,
                        sameWorkspace: c.sameWorkspace,
                        mention: c.mention as string,
                    })),
            };
        } catch (e) {
            console.warn(`[dsh-at] listAtRefs 失败：${e instanceof Error ? e.message : String(e)}`);
            return { files: [], sessions: [] };
        }
    }

    /** 执行一条任意 dsh 斜杠命令(如 /permission write、/compact)，返回 ok 与结果文本(不抛给 UI)。 */
    async runCommand(line: string): Promise<{ ok: boolean; text?: string }> {
        if (!(await this.session.ensureRunning())) {
            return { ok: false, text: 'DSH 服务不可用，无法执行命令' };
        }
        let sid: string;
        try {
            sid = await this.session.getSession();
        } catch {
            // 尚无工作区（服务无法建带归属的会话）：不向上抛，返回可读提示
            return { ok: false, text: '请先选择工作区，再执行命令' };
        }
        try {
            const exec = await runSessionCommand(sid, line);
            if (!exec || exec.result?.kind === 'error') {
                return { ok: false, text: exec?.result?.text || '命令执行失败（无返回）' };
            }
            return { ok: true, text: exec.result?.text };
        } catch (e) {
            return { ok: false, text: e instanceof Error ? e.message : String(e) };
        }
    }

    /**
     * 取回当前会话日志 ZIP（/export 的真实下载数据）。返回 { ok:false, unsupported:true } 表示
     * 运行中的 dsh 没有该下载路由（上层应回退为仅回显 /export 命令文本）；其他失败回退文本描述。
     */
    async fetchSessionLogZip(): Promise<
        | { ok: true; zip: SessionLogZip }
        | { ok: false; unsupported: boolean; text: string }
    > {
        if (!(await this.session.ensureRunning())) {
            return { ok: false, unsupported: false, text: 'DSH 服务不可用，无法导出会话日志' };
        }
        let sid: string;
        try {
            sid = await this.session.getSession();
        } catch {
            // 尚无工作区：不向上抛，返回可读提示（与上面 runCommand 一致）
            return { ok: false, unsupported: false, text: '请先选择工作区，再导出会话日志' };
        }
        try {
            const zip = await fetchSessionLogZipRpc(sid);
            return { ok: true, zip };
        } catch (e) {
            if (e instanceof ExportUnsupportedError) {
                return { ok: false, unsupported: true, text: e.message };
            }
            return { ok: false, unsupported: false, text: e instanceof Error ? e.message : String(e) };
        }
    }
}
