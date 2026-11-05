import sys, re

d = sys.stdin.buffer.read()
# cluster_id is last column: ,"<digits>" at end of a physical line
pat = re.compile(rb',"([0-9]+)"\n')
n = 0
for m in pat.finditer(d):
    s = m.start()
    print("ctx:", repr(d[max(0, s - 60):s + 20]))
    print("---")
    n += 1
    if n >= 8:
        break
print("matches_in_sample:", n)
