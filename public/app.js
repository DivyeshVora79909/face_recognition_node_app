const API_BASE = '/node';
let token = localStorage.getItem('jwt');

// DOM Elements
const loginSection = document.getElementById('login-section');
const userSection = document.getElementById('user-section');
const fileSection = document.getElementById('file-section');

// Login Function
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        token = data.token;
        localStorage.setItem('jwt', token);
        showAuthedSections();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
});

// User Management Functions
async function createUser() {
    const usertype = document.getElementById('usertype').value;
    const email = document.getElementById('new-email').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('new-password').value;

    try {
        const response = await fetch(`${API_BASE}/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ usertype, email, username, password })
        });

        const data = await response.json();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
}

async function getCurrentUser() {
    try {
        const response = await fetch(`${API_BASE}/users/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
}

async function getAllUsers() {
    try {
        const response = await fetch(`${API_BASE}/users`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
}

async function updateUser() {
    const userId = document.getElementById('user-id').value;
    const username = document.getElementById('update-username').value;
    const email = document.getElementById('update-email').value;

    try {
        const response = await fetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ username, email })
        });

        const data = await response.json();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
}

// File Upload Functions
async function uploadFiles() {
    const files = document.getElementById('file-input').files;
    const formData = new FormData();

    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }

    try {
        const response = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        const data = await response.json();
        showResult(data);
    } catch (error) {
        showResult(error.message);
    }
}

// UI Functions
function showAuthedSections() {
    loginSection.classList.add('hidden');
    userSection.classList.remove('hidden');
    fileSection.classList.remove('hidden');
}

function showResult(data) {
    document.getElementById('results').textContent = JSON.stringify(data, null, 2);
}

// Check for existing token on load
if (token) {
    showAuthedSections();
}


function logout() {
  localStorage.removeItem('jwt');
  window.location.href = 'index.html';
}

// Update form event listeners
document.addEventListener('DOMContentLoaded', function() {
  // Handle create user form
  const createUserForm = document.getElementById('create-user-form');
  if(createUserForm) {
      createUserForm.onsubmit = (e) => {
          e.preventDefault();
          createUser();
      }
  }

  // Handle update user form
  const updateUserForm = document.getElementById('update-user-form');
  if(updateUserForm) {
      updateUserForm.onsubmit = (e) => {
          e.preventDefault();
          updateUser();
      }
  }

  // Handle file upload form
  const uploadForm = document.getElementById('upload-form');
  if(uploadForm) {
      uploadForm.onsubmit = (e) => {
          e.preventDefault();
          uploadFiles();
      }
  }
});
