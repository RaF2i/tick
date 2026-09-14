import json

with open('/var/www/Yepp_Marv/package.json') as f:
    data = json.load(f)

data['scripts']['build'] = 'NODE_OPTIONS=--max-old-space-size=4096 tsc && cp -r src/app/utils/templates dist/app/utils/ && cp -r src/app/docs dist/app/docs'

with open('/var/www/Yepp_Marv/package.json', 'w') as f:
    json.dump(data, f, indent=2)

print('DONE')
