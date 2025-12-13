const axios = require('axios');
const BASE_URL = 'https://api.github.com';

async function validateProjectType(owner,repo, branch='main'){
    const filePath = 'package.json';

    const contentUrl = `${BASE_URL}/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

    try {
        const response = await axios.get(contentUrl , {
            headers: {
                'Accept' : 'application/vnd.github.v3.raw'
            },
            responseType: 'text',
        });
        const fileContnent = response.data;
        console.log(fileContnent);
        
        try{
           const packageJson = JSON.parse(fileContnent);
           
           return {
            isValid: true,
            message: `'package.json' found and valid JSON.`,
            data: packageJson
           }
        }
        catch(jsonError){{
            return {
                isValid: false,
                message: `'Package.json' found but it is not a valid JSON.`,
            };
        }}
    }
    catch(error){
       if(error.response && error.response.status === 404){
        return {
            isValid: false,
            message: `'Package.json' not found in the  branch of the '${owner}/${repo}' repository.`,
        };

       }
       const errorMessage = error.response ? `Status ${error.response.status}: ${error.response.statusText}` : error.message;

       return {
        isValid: false,
        message: `Github API Error: ${errorMessage}`,
       };
    }
}

async function runExample() {
    console.log('--- Checking Valid Repo (Anto-099-New-State/clash-cntrx-backend) ---');
    let result = await validateProjectType('Anto-099-New-State', 'clash-cntrx-backend');
    console.log(result);

    console.log('\n--- Checking Invalid Repo (twbs/docs - no package.json) ---');
    result = await validateProjectType('twbs', 'docs');
    console.log(result);
}

runExample();