// 上下文注入投影：把注入事件投影成 UI 需要的 role/label 与展示形态（适配上游 0.1.7-rc.2）。
// 背景：dsh 的上下文注入是一条 source.kind !== 'user' 的 user/message durable 事件
// （agent-instructions / skill-invocation / plugin / session-reference…），
// 宿主页面据此在时间线里渲染成一条「上下文注入 / 跨会话召回」折叠行。
// 判据只看事件自带字段，不自行发明规则；认不出的形态一律走兜底。

/** 表单：生产者声明的信息形态；null = opaque 兜底展示。 */
export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall';

/** Chat 行展示的 role 与生产者名。role='recall'=跨会话召回，其余=上下文注入。 */
export interface ContextProvenanceView {
    role: 'inject' | 'recall';
    label: string | null;
}

const KNOWN_FORMS: readonly KnownContextForm[] = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'];

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 读 source 里一个成员数组的某个字段（label/path），去重保序。 */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
    const list = source[member];
    if (!Array.isArray(list)) {
        return [];
    }
    const seen: string[] = [];
    for (const entry of list) {
        const record = asRecord(entry);
        const value = record === null ? null : readString(record, field);
        if (value !== null && !seen.includes(value)) {
            seen.push(value);
        }
    }
    return seen;
}

function joined(names: string[]): string | null {
    return names.length > 0 ? names.join(', ') : null;
}

/**
 * 读取生产者声明的展示形态；缺省 null（= opaque）。
 * @param source - 记录的 user/message source。
 * @returns 支持的 form，或 null（opaque 展示）。
 */
export function contextForm(source: unknown): KnownContextForm | null {
    const record = asRecord(source);
    const form = record === null ? null : readString(record, 'form');
    return form !== null && (KNOWN_FORMS as readonly string[]).includes(form)
        ? (form as KnownContextForm)
        : null;
}

/**
 * 投影一条非用户 source 的 user/message 到 Chat 行的 role 与生产者名。
 * @param source - 记录的 user/message source。
 * @returns role 与 label。
 */
export function contextProvenance(source: unknown): ContextProvenanceView {
    const record = asRecord(source);
    const kind = record === null ? null : readString(record, 'kind');
    if (record === null || kind === null) {
        return { role: 'inject', label: null };
    }
    switch (kind) {
        case 'session-reference':
            return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind };
        case 'agent-instructions':
            return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind };
        case 'plugin':
            return { role: 'inject', label: readString(record, 'plugin') ?? kind };
        case 'skill-invocation':
            return { role: 'inject', label: readString(record, 'name') ?? kind };
        default:
            // MessageSourceMap 可合并扩展：未知生产者仍按其 durable kind 可见。
            return { role: 'inject', label: kind };
    }
}

/** 是否为一条上下文注入 user/message（source.kind !== 'user' 的非人类表层消息）。 */
export function isContextMessage(event: { type?: string; data?: Record<string, unknown> }): boolean {
    if (event.type !== 'user/message') {
        return false;
    }
    const source = event.data?.['source'];
    const record = asRecord(source);
    return record === null ? false : record['kind'] !== 'user';
}
