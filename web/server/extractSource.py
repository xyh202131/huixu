import csv
import io
import json
import re
import sys
import time
import zipfile
from contextlib import redirect_stdout
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

from archiveSources import ARCHIVES, ArchiveProblem, extension, walk_archive


dependencies = Path(__file__).resolve().parents[1] / '.parser-deps'
if dependencies.is_dir():
    sys.path.insert(0, str(dependencies))

TEXT = {'.md', '.markdown', '.txt', '.json', '.jsonl', '.xml', '.yaml', '.yml'}
IMAGES = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'}
ocr_engine = None


def decode_text(data):
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = data.decode('utf-16')
    else:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = data.decode('gb18030')
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', text):
        raise ValueError('invalid plain text')
    return text


def text_sections(text, derived=False):
    heading = ''
    paragraph = []
    first = 1
    prefix = '提取文本第 ' if derived else '第 '
    lines = text.splitlines()
    for index, raw in enumerate(lines, 1):
        line = raw.strip()
        title = re.match(r'^#{1,6}\s+(.+)$', line)
        if not line or title:
            if paragraph:
                span = str(first) if first == index - 1 else f'{first}–{index - 1}'
                yield prefix + span + ' 行' + (f' · {heading}' if heading else ''), '\n'.join(paragraph)
                paragraph = []
            if title:
                heading = title.group(1)[:100]
                yield f'{prefix}{index} 行', line
        else:
            if not paragraph:
                first = index
            paragraph.append(line)
    if paragraph:
        span = str(first) if first == len(lines) else f'{first}–{len(lines)}'
        yield prefix + span + ' 行' + (f' · {heading}' if heading else ''), '\n'.join(paragraph)


class HtmlText(HTMLParser):
    hidden_tags = {'head', 'script', 'style', 'template', 'noscript'}
    breaks = {'p', 'div', 'br', 'li', 'tr', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}

    def __init__(self):
        super().__init__()
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.hidden_tags:
            self.hidden.append(tag)
        if not self.hidden and tag in self.breaks:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()
        if not self.hidden and tag in self.breaks:
            self.parts.append('\n')
        if not self.hidden and tag in ('td', 'th'):
            self.parts.append(' | ')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def recognize(image):
    import numpy as np
    from rapidocr import RapidOCR

    global ocr_engine
    image.thumbnail((2200, 2200))
    # OCR 日志与解析器 JSON 输出分开。
    with redirect_stdout(sys.stderr):
        if ocr_engine is None:
            ocr_engine = RapidOCR()
        result = ocr_engine(np.asarray(image.convert('RGB'))[:, :, ::-1].copy())
    return '\n'.join(str(line) for line in (result.txts or ()))


def rows_with_headers(rows):
    headers = []
    for location, cells in rows:
        values = [str(cell).strip() if cell is not None else '' for cell in cells]
        if not any(values):
            continue
        if not headers:
            headers = values
            yield location, '表头：' + ' | '.join(values)
            continue
        fields = []
        for index, value in enumerate(values):
            if value:
                label = headers[index] if index < len(headers) and headers[index] else f'第 {index + 1} 列'
                fields.append(f'{label}：{value}')
        yield location, ' | '.join(fields)


def extract(data, suffix, notes, deadline):
    if suffix in TEXT:
        yield from text_sections(decode_text(data))
        return

    if suffix in ('.csv', '.tsv'):
        reader = csv.reader(io.StringIO(decode_text(data), newline=''), delimiter='\t' if suffix == '.tsv' else ',')
        yield from rows_with_headers((f'截至第 {reader.line_num} 行', row) for row in reader)
        return

    if suffix in ('.html', '.htm'):
        parser = HtmlText()
        parser.feed(decode_text(data))
        parser.close()
        yield from text_sections(''.join(parser.parts), derived=True)
        return

    if suffix == '.rtf':
        from striprtf.striprtf import rtf_to_text

        yield from text_sections(rtf_to_text(data.decode('latin-1')), derived=True)
        return

    if suffix in IMAGES:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as image:
            frames = getattr(image, 'n_frames', 1)
            for index in range(min(frames, 12)):
                if time.monotonic() >= deadline:
                    notes.add('达到解析时间上限')
                    break
                image.seek(index)
                if image.width * image.height > 24_000_000:
                    notes.add('部分图像尺寸超出 OCR 上限')
                    continue
                text = recognize(ImageOps.exif_transpose(image))
                yield (f'第 {index + 1} 帧 · OCR' if frames > 1 else '图片 · OCR'), text
            if frames > 12:
                notes.add('仅识别前 12 帧')
        return

    if suffix == '.pdf':
        import fitz

        with fitz.open(stream=data, filetype='pdf') as document:
            scanned = 0
            for index, page in enumerate(document, 1):
                if time.monotonic() >= deadline:
                    notes.add('达到解析时间上限')
                    break
                text = page.get_text(sort=True)
                if text.strip():
                    yield f'第 {index} 页', text
                    continue
                scanned += 1
                if scanned > 12:
                    notes.add('仅尝试前 12 个扫描页的 OCR')
                    continue
                try:
                    from PIL import Image

                    scale = min(2, 2200 / max(page.rect.width, page.rect.height))
                    pixels = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB)
                    text = recognize(Image.frombytes('RGB', (pixels.width, pixels.height), pixels.samples))
                    if text.strip():
                        yield f'第 {index} 页 · OCR', text
                    else:
                        notes.add('部分扫描页未识别到文字')
                except (ImportError, OSError, RuntimeError, ValueError):
                    notes.add('部分扫描页暂未完成 OCR')
        return

    if suffix == '.xls':
        import xlrd

        with xlrd.open_workbook(file_contents=data, on_demand=True) as workbook:
            for sheet in workbook.sheets():
                yield from rows_with_headers((f'{sheet.name} · 第 {index + 1} 行', sheet.row_values(index)) for index in range(sheet.nrows))
        return

    # Office 文件只在内存中解析，先限制解压体积。
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > 80 * 1024 * 1024:
            raise ValueError('office archive too large')

    if suffix == '.xlsx':
        from openpyxl import load_workbook

        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
        try:
            for sheet in workbook.worksheets:
                rows = sheet.iter_rows(values_only=True)
                yield from rows_with_headers((f'{sheet.title} · 第 {index} 行', row) for index, row in enumerate(rows, 1))
        finally:
            workbook.close()
    elif suffix == '.docx':
        from docx import Document

        document = Document(io.BytesIO(data))
        for index, paragraph in enumerate(document.paragraphs, 1):
            if paragraph.text.strip():
                yield f'正文第 {index} 段', paragraph.text
        for table_index, table in enumerate(document.tables, 1):
            rows = ((f'表格 {table_index} · 第 {index} 行', [cell.text for cell in row.cells])
                    for index, row in enumerate(table.rows, 1))
            yield from rows_with_headers(rows)
    elif suffix == '.pptx':
        from pptx import Presentation

        presentation = Presentation(io.BytesIO(data))
        for index, slide in enumerate(presentation.slides, 1):
            for shape_index, shape in enumerate(slide.shapes, 1):
                if shape.has_text_frame:
                    yield f'第 {index} 张幻灯片 · 文本框 {shape_index}', shape.text
                if shape.has_table:
                    rows = ((f'第 {index} 张幻灯片 · 表格 {shape_index} 第 {row_index} 行', [cell.text for cell in row.cells])
                            for row_index, row in enumerate(shape.table.rows, 1))
                    yield from rows_with_headers(rows)


def document(data, suffix, max_chars, max_sections, deadline):
    if suffix in ('.doc', '.ppt'):
        modern = 'DOCX' if suffix == '.doc' else 'PPTX'
        return [], '待转换', f'原件已保存，可导入 {modern} 版本建立索引。'

    sections, notes = [], set()
    try:
        for location, text in extract(data, suffix, notes, deadline):
            text = text.strip()
            if not text:
                continue
            if time.monotonic() >= deadline:
                notes.add('达到解析时间上限')
                break
            if len(sections) == max_sections or max_chars == 0:
                notes.add('达到文字索引上限')
                break
            if len(text) > max_chars:
                text = text[:max_chars]
                notes.add('达到文字索引上限')
            sections.append({'location': location, 'text': text})
            max_chars -= len(text)
    except ImportError:
        if suffix in IMAGES:
            return sections, '待 OCR', '本机 OCR 依赖不可用。'
        return sections, '待处理', '缺少本机解析依赖。'
    except Exception:
        return sections, '部分已索引' if sections else '待处理', '文件部分或全部无法解析，可能已加密、损坏或超出限制。'
    if sections:
        return sections, '部分已索引' if notes else '已索引', '，'.join(sorted(notes))
    if suffix in IMAGES or (suffix == '.pdf' and notes):
        return sections, '待 OCR', '，'.join(sorted(notes)) or '图片未识别到可检索文字。'
    return sections, '无可检索内容', '原件已保存，未提取到可检索文字。'


def archive(data, name, supported):
    sections, entries = [], []
    remaining = 450_000
    budget = {'entries': 0, 'bytes': 0, 'deadline': time.monotonic() + 65}
    note = ''
    try:
        for path, content, problem in walk_archive(data, name, supported, budget):
            if problem:
                entries.append({'path': path, 'state': '已跳过', 'note': problem})
                continue
            if remaining <= 0 or len(sections) >= 2500:
                entries.append({'path': path, 'state': '已跳过', 'note': '达到文字索引上限'})
                note = '达到文字索引上限，已保留此前结果。'
                break
            extracted, state, detail = document(content, extension(PurePosixPath(path).name), remaining, 2500 - len(sections), budget['deadline'])
            entry_index = len(entries)
            entries.append({'path': path, 'state': state, 'note': detail})
            for section in extracted:
                sections.append({'location': f"{path} · {section['location']}", 'text': section['text'], 'entryIndex': entry_index})
                remaining -= len(section['text'])
    except ArchiveProblem as error:
        note = str(error)
    except Exception:
        note = '压缩包无法完整读取，可能已加密或损坏。'
    indexed = sum(entry['state'] in ('已索引', '部分已索引') for entry in entries)
    if sections:
        state = '部分已索引' if note or any(entry['state'] != '已索引' for entry in entries) else '已索引'
    else:
        state = '待处理' if note or entries else '无可检索内容'
    summary = f'包内 {len(entries)} 项已处理，{indexed} 项可检索。' + note
    return {'sections': sections, 'entries': entries, 'state': state, 'note': summary}


def main():
    name = sys.argv[1]
    suffix = extension(name)
    data = sys.stdin.buffer.read()
    if suffix in ARCHIVES:
        payload = archive(data, name, set(sys.argv[2].split(',')))
    else:
        sections, state, note = document(data, suffix, 450_000, 2500, time.monotonic() + 38)
        payload = {'sections': sections, 'state': state, 'note': note}
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))


if __name__ == '__main__':
    main()
