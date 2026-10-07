// 对话区末尾的 pending 插话气泡：提交后**立刻**出现，被取用后原子消失、由日志里的那条用户消息接位。
//
// 为什么固定在**对话列末尾、运行状态行之前**（上游同款：整张行表之后先排 pending 行，运行指示再挂在列表之后）：
//   - 插话还没进日志，没有自己的锚点序号，位置只能由「它是当前回合里最新的人类输入」来定；
//   - 不能把它当成一条消息行塞进 messages —— 行是宿主整表下发的，下一次替换会把它丢掉，
//     而 `buildRows` 会把最终那条用户行**插到未定稿的回答行之前**（日志位置），两者混在一起必然错位。
// 气泡样式与最终的用户行一致（右对齐、同一气泡底），只多一层弱化，表明它还没落账。
import { html } from 'htm/preact'
import type { PendingSteering } from '../../core/store/types'
import { refText } from './ref-text'

export function PendingSteeringList({ items }: { items: readonly PendingSteering[] }) {
  if (items.length === 0) {
    return null
  }
  return html`${items.map(
    (it) => html`<div class="msg user pending-steering" key=${it.key}>
      <div class="col">
        ${it.attachments.length > 0
          ? html`<div class="user-atts">${it.attachments.map((a, i) =>
              a.kind === 'image' && a.preview !== undefined
                ? html`<span class="user-img" key=${`${a.kind}:${String(i)}`}
                    ><img src=${`data:${a.preview.mediaType};base64,${a.preview.data}`} alt=${a.name ?? '图片'} title=${a.name ?? ''} /></span>`
                : html`<span class="pending-steer-att" key=${`${a.kind}:${a.name ?? ''}:${String(i)}`}>
                    <span class=${'codicon codicon-' + (a.kind === 'image' ? 'file-media' : 'file')} aria-hidden="true"></span>
                    <span class="ufname">${a.name ?? (a.kind === 'image' ? '图片' : '文件')}</span>
                  </span>`
            )}</div>`
          : null}
        ${it.text
          ? html`<div class="body"><div class="user-text">${refText(it.text, it.refs)}</div></div>`
          : null}
      </div>
    </div>`
  )}`
}
