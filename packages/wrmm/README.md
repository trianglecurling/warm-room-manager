# WRMM - Warm Room Manager

A modern full-stack web application for managing curling club monitor displays, built with React 19, TypeScript 5.9, Express, Tailwind CSS v4, and TanStack Query.

## 🚀 Features

- **Monitor Management**: Control 4 curling sheet monitors (A, B, C, D)
- **Team Management**: Manage red and yellow teams for each sheet
- **Quick Actions**: Upcoming draw, pull from monitors, clear all, randomize colors
- **Sheet Operations**: Swap colors per sheet, swap entire sheets
- **Real-time Updates**: Publish changes to monitors instantly
- **Frontend**: React 19 with TypeScript
- **Backend**: Express.js with TypeScript
- **Styling**: Tailwind CSS v4
- **Data Management**: TanStack Query (React Query)
- **Build Tool**: Vite
- **Development**: Hot reload for both frontend and backend
- **Production**: Single Express server serving both API and static files

## 📦 Tech Stack

- **React**: 19.0.0
- **TypeScript**: 5.9.2
- **Express**: 4.19.2
- **Tailwind CSS**: 4.0.0-alpha.25
- **TanStack Query**: 5.28.4
- **Vite**: 5.4.10

## 🛠️ Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd wrmm
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   
   The default configuration:
   - `PORT=3013` - Server port
   - `NODE_ENV=development` - Environment

4. **Start development servers**
   ```bash
   npm run dev
   ```
   
   This will start:
   - Backend server on http://localhost:3013
   - Frontend dev server on http://localhost:5173 (with API proxy)

## 📁 Project Structure

```
wrmm/
├── src/
│   ├── client/                 # Frontend React application
│   │   ├── components/         # React components
│   │   ├── hooks/             # Custom React hooks
│   │   ├── api/               # API client and types
│   │   ├── App.tsx            # Main App component
│   │   ├── main.tsx           # React entry point
│   │   ├── index.html         # HTML template
│   │   └── index.css          # Global styles with Tailwind
│   └── server/                # Backend Express application
│       └── index.ts           # Express server
├── dist/                      # Build output
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript config
├── tsconfig.server.json       # Server TypeScript config
├── vite.config.ts             # Vite configuration
├── tailwind.config.js         # Tailwind CSS config
├── postcss.config.js          # PostCSS config
└── README.md                  # This file
```

## 🎯 Available Scripts

- `npm run dev` - Start both frontend and backend in development mode
- `npm run dev:server` - Start only the backend server
- `npm run dev:client` - Start only the frontend dev server
- `npm run build` - Build both frontend and backend for production
- `npm run build:server` - Build only the backend
- `npm run build:client` - Build only the frontend
- `npm start` - Start the production server
- `npm run clean` - Clean build output

## 🌐 API Endpoints

- `GET /api/health` - Server health check
- `GET /api/hello` - Hello message from backend

## 🎨 Styling

The application uses Tailwind CSS v4 with custom component classes:

- `.btn` - Base button styles
- `.btn-primary` - Primary button variant
- `.btn-secondary` - Secondary button variant

## 🔧 Development

### Frontend Development
- React Query DevTools are available in development mode
- Hot module replacement enabled
- TypeScript strict mode enabled

### Backend Development
- TypeScript compilation with `tsx` for fast development
- CORS enabled for frontend communication
- Environment variable support

## 🚀 Production

1. **Build the application**
   ```bash
   npm run build
   ```

2. **Start the production server**
   ```bash
   npm start
   ```

The Express server will serve both the API endpoints and the static frontend files from the same port (3013 by default).

## 📝 Notes

- The frontend is served from the same Express server in production
- API routes are prefixed with `/api`
- React Query is configured with optimistic defaults for better UX
- Tailwind CSS v4 is used with the new `@import` syntax 