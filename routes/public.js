const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getGoogleReviews } = require('../utils/googleReviews');

// All outbound mail is sent from the Hive domain (verified in Resend).
const MAIL_FROM = process.env.MAIL_FROM || 'Hive <vineet.dutta@hiveny.com>';
// Master recipient for submitted inquiry/application details.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'vineet.dutta@hiveny.com';

// Low-level mail send via the Resend HTTP API. Throws on failure so callers can
// log it; callers wrap this so a failed send never blocks saving the inquiry.
async function sendMail({ to, subject, html, replyTo }) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY missing — "${subject}" to ${to} not sent.`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      html,
      reply_to: replyTo || undefined
    })
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  console.log(`[mail] Sent "${subject}" to ${to}`);
}

// Branded wrapper for confirmation emails sent to the person who submitted a form.
function confirmationHtml(heading, bodyLines) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a18;">
      <h2 style="color: #1a1a18;">${heading}</h2>
      ${bodyLines.map(l => `<p style="line-height: 1.6; color: #444;">${l}</p>`).join('')}
      <p style="line-height: 1.6; color: #444;">Warm regards,<br>Vineet Dutta<br>Hive · <a href="https://hiveny.com" style="color: #d4920b;">hiveny.com</a></p>
      <p style="margin-top: 20px; color: #888; font-size: 12px;">This is an automated confirmation from Hive. You can reply directly to this email to reach us.</p>
    </div>`;
}

router.get('/', async (req, res) => {
  try {
    // One listing per property: rooms in the same unit share title + city, so
    // DISTINCT ON (title, city) keeps a single room per property in featuring.
    const { rows: featuredListings } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (lower(btrim(title)), city) *
         FROM listings
         WHERE featured = true AND status != 'rented'
         ORDER BY lower(btrim(title)), city, sort_order ASC
       ) t
       ORDER BY sort_order ASC LIMIT 6`
    );
    // Fallback: if no featured listings, get the most recent available ones
    let listings = featuredListings;
    if (listings.length === 0) {
      const result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (lower(btrim(title)), city) *
           FROM listings
           WHERE status != 'rented'
           ORDER BY lower(btrim(title)), city, created_at DESC
         ) t
         ORDER BY created_at DESC LIMIT 6`
      );
      listings = result.rows;
    }

    // Fetch Google reviews (cached, won't slow down page load)
    const googleReviews = await getGoogleReviews();

    res.render('public/index', { featuredListings: listings, googleReviews });
  } catch (err) {
    console.error('Error loading homepage:', err);
    res.render('public/index', { featuredListings: [], googleReviews: { reviews: [], rating: 0, totalReviews: 0 } });
  }
});

router.get('/properties', async (req, res) => {
  try {
    const { rows: listings } = await pool.query(
      `SELECT * FROM listings WHERE status != 'rented'
       ORDER BY sort_order ASC, created_at DESC`
    );
    // Convert deprecated Drive uc?export URLs to thumbnail format
    listings.forEach(l => { if (l.images) l.images = l.images.map(url => {
      const m = url && url.match(/drive\.google\.com\/(?:uc\?export=view&id=|thumbnail\?id=)([a-zA-Z0-9_-]+)/);
      return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w2000` : url;
    }); });
    res.render('public/properties', { listings });
  } catch (err) {
    console.error('Error loading properties:', err);
    res.render('public/properties', { listings: [] });
  }
});

router.get('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
      return res.redirect('/properties');
    }

    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.redirect('/properties');
    }

    const listing = rows[0];

    // Fetch bookings for this listing (current and future only)
    const { rows: bookings } = await pool.query(
      `SELECT check_in, check_out FROM bookings
       WHERE listing_id = $1 AND check_out >= CURRENT_DATE
       ORDER BY check_in ASC`,
      [id]
    );

    // Fetch related listings (same neighborhood or city, excluding current)
    const { rows: relatedListings } = await pool.query(
      `SELECT * FROM listings
       WHERE id != $1 AND status != 'rented'
       AND (neighborhood = $2 OR city = $3)
       ORDER BY sort_order ASC
       LIMIT 3`,
      [id, listing.neighborhood, listing.city]
    );

    // Convert deprecated Drive uc?export URLs to thumbnail format
    const fixDriveUrl = (url) => {
      if (!url) return url;
      const m = url.match(/drive\.google\.com\/uc\?export=view&id=([a-zA-Z0-9_-]+)/);
      return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w2000` : url;
    };
    if (listing.images) listing.images = listing.images.map(fixDriveUrl);
    if (listing.floor_plan_image) listing.floor_plan_image = fixDriveUrl(listing.floor_plan_image);
    relatedListings.forEach(r => { if (r.images) r.images = r.images.map(fixDriveUrl); });

    res.render('public/listing-detail', { listing, relatedListings, bookings });
  } catch (err) {
    console.error('Error loading listing detail:', err);
    res.redirect('/properties');
  }
});

// Keep .html routes working for backwards compatibility
router.get('/properties.html', (req, res) => res.redirect('/properties'));
router.get('/partners.html', (req, res) => res.redirect('/partners'));

router.get('/partners', async (req, res) => {
  res.render('public/partners');
});

// Apply page
router.get('/apply', (req, res) => {
  res.render('public/apply', { success: false });
});

router.post('/apply', async (req, res) => {
  try {
    const { full_name, email, phone, about, social_media } = req.body;

    // Save to database
    await pool.query(
      `INSERT INTO applications (full_name, email, phone, about, social_media)
       VALUES ($1, $2, $3, $4, $5)`,
      [full_name, email, phone || null, about, social_media]
    );

    // Notify the master inbox with the submitted details (best-effort — already saved)
    try {
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: email,
        subject: `New Hive Application: ${full_name}`,
        html: `
        <h2>New Tenant Application</h2>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 160px;">Name</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${full_name}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Email</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${email}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${phone || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">About</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${about}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Social / LinkedIn</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${social_media}</td></tr>
        </table>
        <p style="margin-top: 20px; color: #888; font-size: 12px;">Submitted via Hive Application Form</p>
      `
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send application notification:', mailErr.message);
    }

    // Send a confirmation to the applicant (best-effort)
    try {
      await sendMail({
        to: email,
        subject: 'We received your Hive application',
        html: confirmationHtml(`Thanks for applying, ${full_name}!`, [
          'We have received your application and our team will review it shortly.',
          'If your profile is a good fit, we will reach out with available homes and next steps.',
          'In the meantime, feel free to browse our latest listings at <a href="https://hiveny.com/properties" style="color: #d4920b;">hiveny.com/properties</a>.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send applicant confirmation:', mailErr.message);
    }

    res.render('public/apply', { success: true });
  } catch (err) {
    console.error('Application submission error:', err);
    // Still show success if DB saved but email failed
    res.render('public/apply', { success: true });
  }
});

// Landlord inquiry form
router.get('/partners/apply', (req, res) => {
  res.render('public/landlord-apply', { success: false });
});

router.post('/partners/apply', async (req, res) => {
  try {
    const { full_name, email, phone, property_location, num_units, property_type, message, referral_source } = req.body;

    // Save to database
    await pool.query(
      `INSERT INTO landlord_inquiries (full_name, email, phone, property_location, num_units, property_type, message, referral_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [full_name, email, phone || null, property_location, num_units || null, property_type || null, message, referral_source || null]
    );

    // Notify the master inbox with the submitted details (best-effort — already saved)
    try {
      await sendMail({
        to: NOTIFY_EMAIL,
        replyTo: email,
        subject: `New Landlord Inquiry: ${full_name}`,
        html: `
        <h2>New Landlord Inquiry</h2>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 160px;">Name</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${full_name}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Email</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${email}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${phone || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Property Location</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${property_location}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Number of Units</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${num_units || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Property Type</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${property_type || 'Not provided'}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Message</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${message}</td></tr>
          <tr><td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Referral Source</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${referral_source || 'Not provided'}</td></tr>
        </table>
        <p style="margin-top: 20px; color: #888; font-size: 12px;">Submitted via Hive Landlord Inquiry Form</p>
      `
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send landlord inquiry notification:', mailErr.message);
    }

    // Send a confirmation to the landlord (best-effort)
    try {
      await sendMail({
        to: email,
        subject: 'Thanks for your interest in partnering with Hive',
        html: confirmationHtml(`Thank you, ${full_name}!`, [
          'We have received your inquiry about partnering with Hive and our team will be in touch soon.',
          'We will review the details you shared about your property and follow up with next steps.'
        ])
      });
    } catch (mailErr) {
      console.error('[mail] Failed to send landlord confirmation:', mailErr.message);
    }

    res.render('public/landlord-apply', { success: true });
  } catch (err) {
    console.error('Landlord inquiry submission error:', err);
    // Still show success if DB saved but email failed
    res.render('public/landlord-apply', { success: true });
  }
});

module.exports = router;
