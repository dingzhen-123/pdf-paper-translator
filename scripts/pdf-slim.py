"""把逐字绘制的 PDF 文本合并成整行，并修正图形状态栈。

BabelDOC 为精确贴合原版式，会把**每个字符**输出成独立的图形状态单元
（源码见 rust/writer_core/src/content.rs::render_character）：

    q <图形状态> BT /F1 10 Tf 1 0 0 1 x y Tm <字形> Tj ET Q

一页两千字就是两千个文本对象、两千对 q/Q。浏览器（PDF.js）能批量处理，
Acrobat 的渲染管线不能，于是打开与滚动都会卡死。

本脚本把「状态完全相同、同一字体字号、同一基线、水平连续」的行内字符
合并进同一个文本对象：

    q <图形状态> BT /F1 10 Tf 1 0 0 1 x0 y0 Tm <g0> Tj 1 0 0 1 x1 y1 Tm <g1> Tj ... ET Q

关键：**每个字形仍用自己的绝对 Tm 定位**，坐标数值一个字都不改，不引入任何
相对位移或浮点累加。合并前后的差异只有 BT/ET 与 q/Q 的配对数量，绘制结果
在数学上完全相同——这也是 Acrobat 不会报「本页面上存在错误」的原因。

另外，引擎输出的页面常以未闭合的 q 结尾（图形状态栈不平衡）。MuPDF 会自动
恢复，Acrobat 则报错。脚本在页面末尾补上缺失的 Q，与渲染器的恢复行为等价。

安全策略：内容流是 PDF 里最脆弱的部分。脚本对每一页都做像素级回验——改完
立刻按原始页面重绘一次逐像素比对，有任何差异就退回该页原文；整份文件保存后
再做结构校验（能否重新打开、是否需要修复、页数、逐页可渲染），不通过则原样
复制输入文件。最坏的结果是「什么都没优化」，绝不会让文件变得更坏。
"""
import json
import re
import shutil
import sys
import time

import pymupdf

# 文本单元：q <状态> BT /字体 字号 Tf [1 0 0 1 x y Tm | x y Td] <字形> Tj ET Q
# 状态里不允许出现裸 Q，惰性匹配到 BT 为止；q 必须是独立操作符。
UNIT = re.compile(
    r'(?<![\w/])(?P<lead>Q\s*)?q\s*(?P<state>[^Q]{0,600}?)\s*BT\s*'
    r'/(?P<font>[^\s/\[\]()<>]+)\s+(?P<size>[-+]?[\d.]+)\s+Tf\s+'
    r'(?:'
    r'(?P<orient>(?:[-+]?[\d.]+\s+){4})(?P<mx>[-+]?[\d.]+)\s+(?P<my>[-+]?[\d.]+)\s+Tm'
    r'|'
    r'(?P<tx>[-+]?[\d.]+)\s+(?P<ty>[-+]?[\d.]+)\s+T[dD]'
    r')'
    r'\s*(?P<text><[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\))\s*Tj\s*ET\s*Q'
)

MAX_GROUP = 200         # 单个合并组最多容纳的字形数
MAX_LINE_CHARS = 12000  # 单个合并组输出的字符上限，远低于阅读器 64K 行限制
Y_TOLERANCE = 0.05      # 判定同一基线的纵向容差（pt）
VERIFY_DPI = 60         # 像素回验的分辨率

HORIZONTAL = ('1', '0', '0', '1')


# BabelDOC 给每个图形元素都套一层 q … Q，并且把**从页首累积下来**的整段图形状态
# 原样重放一遍。一页几千个元素就会累积出上百万个 gs / G 操作符（实测单页 244 万），
# Acrobat 会因此报「本页面上存在错误」，浏览器内核则会容错。这些操作符都是绝对赋值，
# 同名多次出现只有最后一次有效，所以按名字保留末次即可，渲染结果完全等价。
STATE_OPS = {
    b'gs', b'w', b'J', b'j', b'M', b'd', b'ri', b'i',
    b'g', b'G', b'rg', b'RG', b'k', b'K', b'cs', b'CS', b'scn', b'SCN',
}
PREFIX_PASS = {b'cm'}   # 可以穿过但不参与去重（矩阵是累乘，删了会变）
STATE_TOKEN = re.compile(rb'''
    (?P<ws>\s+)
  | (?P<comment>%[^\r\n]*)
  | (?P<hex><[0-9A-Fa-f\s]*>)
  | (?P<str>\((?:[^()\\]|\\.)*\))
  | (?P<num>[-+]?(?:\d+\.?\d*|\.\d+))
  | (?P<name>/[^\s/\[\]()<>{}%]*)
  | (?P<op>[A-Za-z'"*][A-Za-z0-9'"*]*)
  | (?P<arr>[\[\]{}])
  | (?P<other>\S)
''', re.X | re.S)

DEDUPE_MIN_GS = 2000   # 少于这么多 gs 的页不值得动，直接跳过
MERGE_MAX_BYTES = 400_000  # 超过这个体量只做状态去重，不再跑逐字合并
DEADLINE_SECONDS = 75      # 整个后处理的硬预算，超时就不再处理剩余页


def _tokens(data: bytes):
    """把内容流切成 (起点, 终点, 类型, 原文) 的列表；字符串与十六进制串各自成体。"""
    out = []
    pos = 0
    for match in STATE_TOKEN.finditer(data):
        if match.start() > pos:
            out.append((pos, match.start(), 'other', data[pos:match.start()]))
        out.append((match.start(), match.end(), match.lastgroup, match.group()))
        pos = match.end()
    if pos < len(data):
        out.append((pos, len(data), 'other', data[pos:]))
    return out


Q_OP = re.compile(rb'(?<![A-Za-z0-9/])q(?![A-Za-z0-9])')
INLINE_IMAGE = re.compile(rb'(?<![A-Za-z0-9/])BI\s')


def dedupe_states(content: str):
    """把 q … Q 块开头的重复状态前缀按操作符名去重，返回 (新内容, 删除的操作数)。"""
    data = content.encode('latin1')
    if data.count(b' gs') < DEDUPE_MIN_GS:
        return content, 0
    # 内联图像的数据是二进制，逐字节扫描可能误伤，这类页面直接不动。
    if INLINE_IMAGE.search(data):
        return content, 0
    drop = []
    scan = STATE_TOKEN.match
    for head in Q_OP.finditer(data):
        index = head.end()
        operands_start = index
        runs = []
        while True:
            match = scan(data, index)
            if match is None:
                break
            kind, value = match.lastgroup, match.group()
            if kind in ('ws', 'comment'):
                index = match.end()
                continue
            if kind != 'op':
                index = match.end()
                continue
            if value in STATE_OPS:
                runs.append((match.start(), match.end(), value, operands_start))
                operands_start = match.end()
                index = match.end()
                continue
            if value in PREFIX_PASS:
                operands_start = match.end()
                index = match.end()
                continue
            break
        if len(runs) > 1:
            last = {}
            for order, run in enumerate(runs):
                last[run[2]] = order
            for order, (_, end_pos, name, start_pos) in enumerate(runs):
                if last[name] == order:
                    continue
                drop.append((start_pos, end_pos))
    if not drop:
        return content, 0
    drop.sort()
    result = bytearray()
    pos = 0
    count = 0
    for start, end in drop:
        if start < pos:
            continue
        result += data[pos:start] + b' '
        pos = end
        count += 1
    result += data[pos:]
    return result.decode('latin1'), count


def num(value):
    text = f'{value:.5f}'.rstrip('0').rstrip('.')
    return '0' if text in ('', '-0') else text


def glyph_of(unit):
    """归一化成 (orient元组, x, y, text)；Td 定位视作水平单位矩阵平移。"""
    orient_raw = unit.group('orient')
    if orient_raw:
        parts = tuple(num(float(item)) for item in orient_raw.split())
        x = float(unit.group('mx'))
        y = float(unit.group('my'))
    else:
        parts = HORIZONTAL
        x = float(unit.group('tx'))
        y = float(unit.group('ty'))
    return parts, x, y, unit.group('text')


def merge_stream(content: str):
    """返回 (合并后内容, 合并前单元数, 合并后单元数)。"""
    units = list(UNIT.finditer(content))
    if not units:
        return content, 0, 0

    out = []
    last = 0
    group = []
    group_chars = 0

    def flush():
        nonlocal group, group_chars
        if not group:
            return
        if len(group) == 1:
            out.append(group[0].group(0))
        else:
            first = group[0]
            lead = first.group('lead') or ''
            state = first.group('state').strip()
            head = f'{lead}q' + (f' {state}' if state else '')
            parts = [f'{head} BT /{first.group("font")} {first.group("size")} Tf']
            for unit in group:
                orient, x, y, text = glyph_of(unit)
                parts.append(f'{" ".join(orient)} {num(x)} {num(y)} Tm {text} Tj')
            parts.append('ET Q')
            out.append(' '.join(parts))
        group = []
        group_chars = 0

    for unit in units:
        gap = content[last:unit.start()]
        if group:
            previous = group[-1]
            orient, x, y, text = glyph_of(unit)
            prev_orient, prev_x, prev_y, _ = glyph_of(previous)
            size = float(unit.group('size') or 0) or 1.0
            step = x - prev_x
            joinable = (
                previous.group('state') == unit.group('state')
                and previous.group('font') == unit.group('font')
                and previous.group('size') == unit.group('size')
                and orient == prev_orient == HORIZONTAL
                and gap.strip() == ''
                and abs(y - prev_y) <= Y_TOLERANCE
                and 0 < step <= size * 6
                and len(group) < MAX_GROUP
                and group_chars + len(text) < MAX_LINE_CHARS
            )
            if joinable:
                group.append(unit)
                group_chars += len(text)
                last = unit.end()
                continue
            flush()
        out.append(gap)
        group.append(unit)
        group_chars += len(glyph_of(unit)[3])
        last = unit.end()

    flush()
    out.append(content[last:])
    merged = ''.join(out)
    return merged, len(units), len(UNIT.findall(merged))


def _skip_inline_image(content: str, index: int):
    """从 'BI' 之后跳到 'EI' 之后，返回新下标；找不到则返回 None。"""
    marker = content.find('EI', index)
    while marker >= 0:
        before = content[marker - 1] if marker > 0 else ' '
        after = content[marker + 2] if marker + 2 < len(content) else ' '
        if not before.isalnum() and not after.isalnum():
            return marker + 2
        marker = content.find('EI', marker + 2)
    return None


def scan_depth(content: str):
    """统计 q/Q 嵌套深度，跳过字符串、十六进制串、注释与内联图像数据。"""
    depth = 0
    lowest = 0
    index = 0
    size = len(content)
    while index < size:
        char = content[index]
        if char == '(':
            level = 1
            index += 1
            while index < size and level:
                if content[index] == chr(92):
                    index += 2
                    continue
                if content[index] == '(':
                    level += 1
                elif content[index] == ')':
                    level -= 1
                index += 1
            continue
        if char == '<' and index + 1 < size and content[index + 1] != '<':
            end = content.find('>', index)
            index = size if end < 0 else end + 1
            continue
        if char == '%':
            end = content.find('\n', index)
            index = size if end < 0 else end + 1
            continue
        if (
            char == 'B'
            and content.startswith('BI', index)
            and (index == 0 or not content[index - 1].isalnum())
        ):
            jump = _skip_inline_image(content, index + 2)
            if jump is not None:
                index = jump
                continue
        if char in 'qQ':
            before_ok = index == 0 or not content[index - 1].isalnum()
            after_ok = index + 1 >= size or not content[index + 1].isalnum()
            if before_ok and after_ok:
                depth += 1 if char == 'q' else -1
                lowest = min(lowest, depth)
                index += 1
                continue
        index += 1
    return depth, lowest


def balance_states(content: str):
    """补齐缺失的 Q（或缺失的 q），让图形状态栈在页面结束时回到初始层。"""
    depth, lowest = scan_depth(content)
    if depth > 0:
        return content + '\n' + 'Q ' * depth, depth, 0
    if lowest < 0:
        return 'q ' * (-lowest) + '\n' + content, 0, -lowest
    return content, 0, 0


def render(page, dpi=VERIFY_DPI):
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False)
    return pix.width, pix.height, pix.samples


def same_render(source, work):
    try:
        left = render(source)
    except Exception:
        return True  # 原页本身就画不出来，无从比较，交给结构校验兜底。
    try:
        right = render(work)
    except Exception:
        return False
    return left == right


def verify_output(path, expect_pages):
    """结构校验：能否重开、是否需要修复、页数是否一致、每页是否可渲染。"""
    try:
        doc = pymupdf.open(path)
    except Exception:
        return '无法重新打开'
    try:
        if doc.page_count != expect_pages:
            return f'页数不一致 {doc.page_count}/{expect_pages}'
        if getattr(doc, 'is_repaired', False):
            return '结构需要修复'
        for page in doc:
            render(page, dpi=36)
    except Exception as error:
        return f'渲染失败 {error}'
    finally:
        doc.close()
    return ''


def slim(path: str, out_path: str, mode: str = 'merge'):
    # 先整份复制，再对副本做增量保存：原文件的对象、交叉引用表、对象流全部
    # 原样保留，只在文件尾部追加被改动的内容流。相比重建整份结构，这种做法
    # 对阅读器最友好——Acrobat 的兼容问题多来自文件被重排。
    shutil.copyfile(path, out_path)
    source = pymupdf.open(path)
    work = pymupdf.open(out_path)
    total_pages = source.page_count
    units_before = units_after = balanced = 0
    merged_pages = 0
    deduped_pages = dedupe_total = 0
    started = time.time()
    truncated = 0
    changed = 0
    reverted = []

    try:
        for number in range(total_pages):
            # 硬预算：到点就停，剩余页保持原样。宁可少优化，也不能让用户干等。
            if time.time() - started > DEADLINE_SECONDS:
                truncated = total_pages - number
                break
            src_page = source[number]
            page = work[number]
            try:
                original = page.read_contents()
            except Exception:
                continue
            content = original.decode('latin1')
            # 先去重状态前缀（这是 Acrobat 报页面错误的根因），再合并逐字文本单元。
            deduped, dropped = dedupe_states(content)
            if dropped:
                deduped_pages += 1
                dedupe_total += dropped
            if mode == 'merge' and len(deduped) <= MERGE_MAX_BYTES:
                merged, old_count, new_count = merge_stream(deduped)
            else:
                merged, old_count, new_count = deduped, 0, 0
            balanced_content, closed, opened = balance_states(merged)
            if balanced_content == content:
                continue
            if old_count:
                units_before += old_count
                units_after += new_count
            balanced += closed + opened
            try:
                xrefs = page.get_contents()
                if not xrefs:
                    continue
                work.update_stream(xrefs[0], balanced_content.encode('latin1'))
                for extra in xrefs[1:]:
                    work.update_stream(extra, b'')
            except Exception:
                continue
            changed += 1

            # 像素回验：改完立刻对比原始页面，任何差异都退回原文。
            if same_render(src_page, work[number]):
                if old_count:
                    merged_pages += 1
            else:
                try:
                    xrefs = work[number].get_contents()
                    work.update_stream(xrefs[0], original)
                except Exception:
                    pass
                if old_count:
                    units_before -= old_count
                    units_after -= new_count
                changed -= 1
                reverted.append(number + 1)

        if changed == 0:
            return {
                'ok': True, 'skipped': True, 'mode': mode, 'pages': total_pages,
                'units_before': 0, 'units_after': 0, 'merged_pages': 0,
                'balanced': 0, 'deduped': 0, 'truncated': truncated, 'reverted': [],
            }

        work.save(out_path, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    finally:
        work.close()
        source.close()

    problem = verify_output(out_path, total_pages)
    if problem:
        # 校验不过：放弃优化，原样交出输入文件。
        shutil.copyfile(path, out_path)
        return {
            'ok': False, 'reason': problem, 'mode': mode, 'pages': total_pages,
            'units_before': 0, 'units_after': 0, 'merged_pages': 0,
            'balanced': 0, 'deduped': 0, 'truncated': truncated, 'reverted': [],
        }

    return {
        'ok': True, 'skipped': False, 'mode': mode, 'pages': total_pages,
        'units_before': units_before, 'units_after': units_after,
        'merged_pages': merged_pages, 'balanced': balanced,
        'deduped': dedupe_total, 'deduped_pages': deduped_pages,
        'truncated': truncated, 'seconds': round(time.time() - started, 1),
        'reverted': reverted,
    }


if __name__ == '__main__':
    args = [item for item in sys.argv[1:] if not item.startswith('--')]
    mode = 'balance' if ('--mode=balance' in sys.argv or '--balance' in sys.argv) else 'merge'
    if len(args) < 2:
        print('用法: python pdf-slim.py <输入.pdf> <输出.pdf> [--mode=balance]')
        raise SystemExit(1)
    try:
        info = slim(args[0], args[1], mode)
    except Exception as error:
        shutil.copyfile(args[0], args[1])
        info = {'ok': False, 'reason': str(error), 'mode': mode}
    print(json.dumps(info, ensure_ascii=False))
