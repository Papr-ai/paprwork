import urllib.request, urllib.parse, sys
from bs4 import BeautifulSoup

q = " ".join(sys.argv[1:])
data = urllib.parse.urlencode({'q': q}).encode('utf-8')
req = urllib.request.Request('https://lite.duckduckgo.com/lite/', data=data, headers={'User-Agent': 'Mozilla/5.0'})
try:
    html = urllib.request.urlopen(req).read()
    soup = BeautifulSoup(html, 'html.parser')
    for tr in soup.find_all('tr'):
        td = tr.find('td', class_='result-snippet')
        if td:
            print("- " + td.text.strip())
        a = tr.find('a', class_='result-url')
        if a:
            print("  URL: " + a['href'])
except Exception as e:
    print(e)
