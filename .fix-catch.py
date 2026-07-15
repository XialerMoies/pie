import re

path = 'src/frontend/pane/explorer/index.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Line 60 catch block
content = content.replace(
    "catch (e: any) {\n      const msg = e.message || '加载失败';",
    "catch (e: unknown) {\n      const msg = e instanceof Error ? e.message : String(e);"
)

# Line 172 catch block
content = content.replace(
    "catch (e: any) {\n      console.error('[explorer] read failed:', e);\n      toast('读取失败: ' + (e.message || e), 'error');",
    "catch (e: unknown) {\n      const msg = e instanceof Error ? e.message : String(e);\n      console.error('[explorer] read failed:', e);\n      toast('读取失败: ' + msg, 'error');"
)

# Line 180 .catch block
content = content.replace(
    '.catch((e: any) => {',
    '.catch((e: unknown) => {'
)
content = content.replace(
    "const msg = e?.message || '';",
    "const msg = e instanceof Error ? e.message : String(e);"
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('explorer done')
