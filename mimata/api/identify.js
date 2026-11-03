/**
 * MiMata — Función serverless (Vercel) de identificación de plantas por foto.
 * Es la MISMA función de NIC (../../api/identify.js, Groq): no se duplica la
 * lógica de modelos, reintentos y parseo. MiMata manda locale:'sv' y la
 * función responde con el prompt tropicalizado a El Salvador y en voseo.
 *
 * Este proyecto de Vercel (Root Directory: mimata) necesita su propia
 * variable GROQ_API_KEY (puede ser la misma clave que usa NIC).
 */

export { default } from '../../api/identify.js';
