const mysql = require('mysql2');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'zin0990$#', // သင့် MySQL Password ထည့်ပါ
    database: 'please'
});

module.exports = pool.promise();