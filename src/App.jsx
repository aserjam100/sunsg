import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useSunPosition } from './hooks/useSunPosition'

const SG_CENTER = [103.8198, 1.3521]
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

const SG_POSTAL_CODES = [
  '545542', // Hougang Ave 8
  '018956', // Marina Bay Sands
  '238823', // Paragon, Orchard
  '049483', // VivoCity, HarbourFront
  '048616', // One Raffles Place
  '139951', // Queensway
  '310103', // Toa Payoh Central
  '460101', // Bedok North
  '520101', // Ang Mo Kio Ave 1
  '730151', // Woodlands Ave 1
]

// SunCalc azimuth: from south, CW in radians
// Mapbox directional direction: [azimuth_deg from north CW, polar_deg 0=zenith 90=horizon]
function sunToMapboxDirection(azimuth, altitude) {
  const bearingDeg = ((azimuth * 180) / Math.PI + 180) % 360
  const altitudeDeg = (altitude * 180) / Math.PI
  const polar = Math.max(1, Math.min(90, 90 - altitudeDeg))
  return { azimuth: bearingDeg, polar }
}

// Map sun altitude to Standard-style light preset (affects bg colour, roads, water, atmosphere)
function toPreset(altDeg) {
  if (altDeg > 6)  return 'day'
  if (altDeg > -6) return 'dusk'
  return 'night'
}

function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function minutesToTimeLabel(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function buildDate(dateStr, minuteOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  return dt
}

export default function App() {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)
  const prevPresetRef = useRef(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [mapError, setMapError] = useState(null)

  const [minuteOfDay, setMinuteOfDay] = useState(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })
  const [postalInput, setPostalInput] = useState(
    () => SG_POSTAL_CODES[Math.floor(Math.random() * SG_POSTAL_CODES.length)]
  )
  const initialPostalRef = useRef(postalInput)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [dateStr, setDateStr] = useState(() => toDateString(new Date()))
  const [dateExpanded, setDateExpanded] = useState(false)

  const selectedDate = buildDate(dateStr, minuteOfDay)
  const sun = useSunPosition({ date: selectedDate, lat: SG_CENTER[1], lng: SG_CENTER[0] })
  const sliderMinutes = Math.round(minuteOfDay / 15) * 15
  const altDeg = (sun.altitude * 180) / Math.PI

  const searchPostal = useCallback(async (code) => {
    const map = mapRef.current
    if (!map || !code.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(code.trim())}.json?country=sg&access_token=${MAPBOX_TOKEN}`
      )
      const data = await res.json()
      const coords = data.features?.[0]?.center
      if (!coords) { setSearchError('Postal code not found'); return }
      // Pan only — preserve current zoom
      map.easeTo({ center: coords, duration: 800 })
    } catch {
      setSearchError('Search failed')
    } finally {
      setSearching(false)
    }
  }, [])

  // Map init — Standard style is required for cast-shadows
  useEffect(() => {
    if (!MAPBOX_TOKEN || mapRef.current) return

    if (!mapboxgl.supported()) {
      setMapError('WebGL is not supported in your browser.')
      return
    }

    mapboxgl.accessToken = MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/standard',
      center: SG_CENTER,
      zoom: 17,
      pitch: 60,
      bearing: -20,
      antialias: true,
    })

    mapRef.current = map

    map.on('load', async () => {
      // Geocode postal code and fly there
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${initialPostalRef.current}.json?country=sg&access_token=${MAPBOX_TOKEN}`
        )
        const data = await res.json()
        const coords = data.features?.[0]?.center
        if (coords) {
          map.jumpTo({ center: coords })   // zoom/pitch/bearing already set at init
        }
      } catch (e) {
        console.warn('[geocode]', e)
      }

      map.addControl(new mapboxgl.NavigationControl(), 'top-right')
      setMapLoaded(true)
    })

    map.on('error', (e) => {
      console.error('[mapbox]', e.error)
      const s = e.error?.status
      if (s === 401) setMapError('Invalid Mapbox token (401).')
      else if (s === 403) setMapError('Mapbox token forbidden (403).')
    })

    return () => {
      setMapLoaded(false)
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Lighting — runs on every sun position change
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Only update lightPreset when the category changes (day/dusk/night) — calling it
    // on every tick triggers a full style re-render and causes visible flickering
    const preset = toPreset(altDeg)
    if (preset !== prevPresetRef.current) {
      try {
        map.setConfigProperty('basemap', 'lightPreset', preset)
        prevPresetRef.current = preset
      } catch (_) {}
    }

    try {
      if (!sun.isDaytime) {
        // Night / twilight: no directional, dim ambient
        const twilight = Math.max(0, Math.min(1, (altDeg + 6) / 6))
        map.setLights([{
          id: 'ambient',
          type: 'ambient',
          properties: { color: '#3a4a6a', intensity: 0.3 + twilight * 0.35 },
        }])
      } else {
        const { azimuth, polar } = sunToMapboxDirection(sun.azimuth, sun.altitude)
        const t = Math.max(0, Math.min(1, sun.altitude / (Math.PI / 2)))

        map.setLights([
          {
            id: 'sun',
            type: 'directional',
            properties: {
              color: t > 0.25 ? '#ffffff' : '#ffcc88',
              intensity: 0.7 + t * 0.3,   // always bright so shadow edges are sharp
              direction: [azimuth, polar],
              'cast-shadows': true,
              'shadow-intensity': 1,        // maximum shadow darkness
            },
          },
          {
            id: 'ambient',
            type: 'ambient',
            properties: { color: '#c8daf0', intensity: 0.1 }, // low ambient = deep shadows
          },
        ])
      }
    } catch (err) {
      console.warn('[setLights]', err)
    }
  }, [sun.altitude, sun.azimuth, sun.isDaytime, mapLoaded, altDeg])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-100">
        <div className="max-w-md text-center p-8 bg-white rounded-2xl border border-slate-200 shadow-xl">
          <h1 className="text-xl font-bold mb-3 text-slate-800">Mapbox Token Required</h1>
          <p className="text-slate-500 mb-4 text-sm">
            Add your token to <code className="bg-slate-100 px-1 rounded text-amber-600">.env</code>:
          </p>
          <pre className="bg-slate-100 text-green-700 text-sm p-4 rounded-lg text-left">
            VITE_MAPBOX_TOKEN=pk.eyJ1Ijoi...
          </pre>
          <p className="text-slate-400 text-xs mt-3">Then restart <code>pnpm dev</code>.</p>
        </div>
      </div>
    )
  }

  const isDark = altDeg <= -6

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-100">
      {/* Map canvas — no Tailwind positioning so Mapbox owns position:relative */}
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Loading */}
      {!mapLoaded && !mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 z-10">
          <div className="text-center">
            <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-slate-400 text-sm">Loading map…</p>
          </div>
        </div>
      )}

      {/* Error */}
      {mapError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 max-w-sm w-full px-4">
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-sm shadow">
            {mapError}
          </div>
        </div>
      )}

      {/* Side panel */}
      <div className="absolute left-3 top-3 z-10 w-52">
        <div className={`backdrop-blur-md rounded-xl p-3 shadow-xl border transition-colors duration-700 ${
          isDark
            ? 'bg-slate-900/90 border-slate-700'
            : 'bg-white/90 border-slate-200'
        }`}>
          {/* Postal code */}
          <form
            onSubmit={(e) => { e.preventDefault(); searchPostal(postalInput) }}
            className="flex gap-1.5 mb-3"
          >
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="Postal code"
              value={postalInput}
              onChange={(e) => { setPostalInput(e.target.value); setSearchError(null) }}
              className={`flex-1 min-w-0 text-sm rounded-lg px-2 py-1.5 border focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent ${
                isDark
                  ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-500'
                  : 'bg-slate-50 border-slate-300 text-slate-800 placeholder-slate-400'
              }`}
            />
            <button
              type="submit"
              disabled={searching}
              className="shrink-0 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors font-medium"
            >
              {searching ? '…' : 'Go'}
            </button>
          </form>
          {searchError && (
            <p className="text-red-500 text-xs -mt-2 mb-2">{searchError}</p>
          )}

          {/* Time slider */}
          <input
            type="range" min={0} max={1440} step={15} value={sliderMinutes}
            onChange={(e) => setMinuteOfDay(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(sliderMinutes / 1440) * 100}%, ${isDark ? '#475569' : '#cbd5e1'} ${(sliderMinutes / 1440) * 100}%, ${isDark ? '#475569' : '#cbd5e1'} 100%)`,
            }}
          />
          <div className={`flex justify-between text-xs mt-1 mb-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span>00:00</span><span>{minutesToTimeLabel(sliderMinutes)}</span><span>24:00</span>
          </div>

          {/* Date toggle */}
          <button
            onClick={() => setDateExpanded(v => !v)}
            className={`w-full text-xs py-1 rounded-lg border transition-colors ${
              isDark
                ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
            }`}
          >
            {dateExpanded ? '▲ hide date' : `▼ ${dateStr === toDateString(new Date()) ? 'change date' : dateStr}`}
          </button>

          {dateExpanded && (
            <div className="mt-2 flex gap-1.5">
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className={`flex-1 min-w-0 text-xs rounded-lg px-2 py-1.5 border focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent ${
                  isDark
                    ? 'bg-slate-800 border-slate-600 text-white'
                    : 'bg-slate-50 border-slate-300 text-slate-800'
                }`}
              />
              {dateStr !== toDateString(new Date()) && (
                <button
                  onClick={() => setDateStr(toDateString(new Date()))}
                  className={`shrink-0 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                    isDark
                      ? 'border-slate-700 text-slate-400 hover:text-slate-200'
                      : 'border-slate-200 text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Today
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

