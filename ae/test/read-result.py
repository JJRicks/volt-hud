# python3 -I read-result.py <x-result.aepx> : prints the JSON held in the VH_RESULT folder comment
import sys, re, html, json
s = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'<Item[^>]*>.*?VH_RESULT', s, re.S)
for c in re.findall(r'<Comment>(.*?)</Comment>', s, re.S):
    c = html.unescape(c)
    if c.startswith('{'):
        print(json.dumps(json.loads(c, strict=False), indent=1)); break
else:
    print('no result found'); sys.exit(1)
