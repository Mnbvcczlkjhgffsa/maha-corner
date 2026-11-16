# MAHA CORNER

मराठी डिजिटल माहिती व पोस्टर मेकर प्रकल्प.

## सध्याची रचना
- `index.html`: सध्या उपलब्ध असलेली स्वतंत्र (static) पोस्टर मेकर वेबसाइट.
- `diwali.html`: दिवाळी शुभेच्छा पृष्ठ.
- `aistudio-source/`: Google AI Studio मधून उपलब्ध झालेल्या React/TypeScript स्रोत फाइल्स, चाचणी फाइल्स आणि Firebase blueprint यांचा संदर्भ-संग्रह.

## महत्त्वाची नोंद
`aistudio-source/App.tsx` मधील imports मध्ये `components/`, `contexts/`, `utils/`, `types` आणि इतर मॉड्यूल्सचा संदर्भ आहे. त्या सर्व अवलंबित फाइल्स या रिपॉझिटरीमध्ये अजून उपलब्ध नाहीत. त्यामुळे हा फोल्डर सध्या पूर्णपणे build होणारा React application नाही. अपूर्ण फाइल्स बनावट पद्धतीने तयार केलेल्या नाहीत.

Firebase config/credentials किंवा secrets GitHub मध्ये commit करू नका. सार्वजनिक client config वापरत असल्यास Firebase Security Rules, authorized domains आणि API key restrictions तपासा. खरे secrets GitHub Actions Secrets मध्येच ठेवा.

## GitHub Pages
या रिपॉझिटरीत GitHub Actions workflow जोडले आहे. GitHub मधील **Settings → Pages → Build and deployment → Source → GitHub Actions** निवडल्यानंतर root मधील static वेबसाइट deploy होऊ शकते. Workflow पूर्ण झाल्यावर Actions tab मध्ये deployment status तपासा.

## पुढील React migration साठी आवश्यक
Google AI Studio प्रकल्पातून संपूर्ण source export करून खालील गोष्टी जोडणे आवश्यक आहे:
- सर्व `src/components/**`, `src/contexts/**`, `src/utils/**`, `src/types.ts`
- `package.json` आणि lockfile
- `vite.config.*`, `tsconfig*.json`, `index.html`
- वापरलेले public assets आणि सुरक्षित Firebase setup

सध्याचा static `index.html` जतन केला आहे; React app पूर्ण झाल्याशिवाय तो replace करू नये.
