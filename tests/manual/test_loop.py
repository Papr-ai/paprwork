import requests
from bs4 import BeautifulSoup

def search_ddg(q):
    r = requests.get(f"https://html.duckduckgo.com/html/?q={requests.utils.quote(q)}", headers={'User-Agent': 'Mozilla/5.0'})
    soup = BeautifulSoup(r.text, 'html.parser')
    for a in soup.find_all('a', class_='result__snippet'):
        print(a.text)

search_ddg('linkedin ERR_TOO_MANY_REDIRECTS puppeteer authwall loop stealth')
