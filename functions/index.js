/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {setGlobalOptions} = require("firebase-functions");
// const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started
// const functions = require("firebase-functions");
// const admin = require("firebase-admin");
// const pdfParse = require("pdf-parse");
// const {Storage} = require("@google-cloud/storage");
// const {VertexAI} = require("@google-cloud/vertexai");

// Firebase Functions v2 (Storage)
const {onObjectFinalized} = require("firebase-functions/v2/storage");
// const logger = require("firebase-functions/logger");

const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const {Storage} = require("@google-cloud/storage");
const {VertexAI} = require("@google-cloud/vertexai");

admin.initializeApp();
const gcs = new Storage();

// --- configure your region & project ---
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const LOCATION = "us-west1"; // "us-central1"; // match your Vertex region

// Pick an available model in your project
const GENERATION_MODEL = "gemini-2.5-flash"; // "gemini-2.5-flash-001"; // or a *-latest visible in your project

// Extracted into function

/**
 * Analyzes resume text using Vertex AI and saves the analysis to Firestore
 * @param {string} text - The extracted resume text content
 * @param {string} fileID - The unique file identifier in Firestore
 * @param {string} filePath - The file path in Firebase Storage
 * @return {Promise<Object>} The parsed analysis result from Vertex AI
 */
async function analyzeResumeText(text, fileID, filePath) { // , bucketName){
  try {
    if (text.trim().length < 100) {
      logger.warn("Resume text too short or empty.");
    }

    // Call Vertex AI for analysis
    const vertexAI = new VertexAI({project: PROJECT_ID, location: LOCATION});
    const model = vertexAI.getGenerativeModel({model: GENERATION_MODEL});

    const system = `You are an expert resume reviewer for software/tech roles.
Return STRICT JSON with the following schema:
{
  "summary": "2-4 sentences",
  "strengths": ["..."],
  "gaps": ["..."],
  "suggested_improvements": ["..."],
  "role_suggestions": ["..."],
  "keywords": {
    "skills": ["normalized technical skills"],
    "tools": ["frameworks/libraries"],
    "domains": ["areas like backend, ML, data"],
    "seniority": "Junior|Mid|Senior"
  }
}`;
    //
    const prompt = `Resume text:\n${text}\n\nGenerate the JSON now. Do not include explanations.`;

    const resp = await model.generateContent({
      contents: [
        {role: "user", parts: [{text: system}]},
        {role: "user", parts: [{text: prompt}]},
      ],
      generationConfig: {responseMimeType: "application/json"},
    });

    const raw = resp.response?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    // const raw = resp.response?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    // let parsed;
    // try {
    //   parsed = JSON.parse(raw);
    // } catch {
    //   parsed = {rawText: raw};
    // }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {rawText: raw};
    }

    // Save analysis to Firestore
    const fileRef = admin.firestore().collection("file").doc(fileID);
    await admin.firestore().runTransaction(async (transaction) => {
      const fileDoc = await transaction.get(fileRef);

      if (!fileDoc.exists) {
        logger.error(`File document not found for fileID: ${fileID}`);
        return;
      }

      const currentNumAnalysis = fileDoc.data().numAnalysis || 0;
      const newIdx = currentNumAnalysis + 1;
      const analysisID = `${fileID}-${newIdx}`;

      transaction.update(fileRef, {
        lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        numAnalysis: newIdx,
        [`analysis.${newIdx}`]: analysisID,
      });

      const analysisRef = admin.firestore().collection("analysis").doc(analysisID);
      transaction.set(analysisRef, {
        owner: fileDoc.data().owner || "",
        fileID: fileID,
        content: parsed,
        generateTime: admin.firestore.FieldValue.serverTimestamp(),
        model: GENERATION_MODEL,
        userRating: null,
        userComment: null,
        nextAnalysis: null,
      });
    });

    logger.info("Analysis saved in Firestore for file", {fileID, filePath});
    return parsed;
  } catch (error) {
    logger.error("analyzeResumeText error:", error);
    throw error;
  }

}

exports.onResumeUploaded = onObjectFinalized(
    {
      region: LOCATION, // keep close to your bucket/Vertex region
      // memory: "512MiB",
      // timeoutSeconds: 120,
      // cpu: 1,
      // secrets: [], // if you ever need secrets
    },
    async (event) => {
      try {
        // v2 storage event
        const object = event.data; // StorageObject
        const filePath = object.name || "";
        if (!filePath) {
          logger.warn("No object.name in event; exiting.");
          return;
        }

        // if (!filePath.startsWith("resumes/") || !filePath.endsWith(".pdf")) return;
        if (!filePath.endsWith(".pdf")) {
          logger.debug(`Skipping non-PDF file: ${filePath}`);
          return;
        }

        const bucketName = object.bucket;
        if (!bucketName) {
          logger.error("Missing bucket in event data.");
          return;
        }

        // 1) Download PDF
        const [buffer] = await gcs.bucket(bucketName).file(filePath).download();

        // 2) Extract text
        const resumeText = (await pdfParse(buffer)).text || "";
        if (resumeText.trim().length < 100) {
          logger.warn("Resume text too short or empty.");
        }

        // // 3) Call Vertex AI (Gemini) for JSON feedback + keywords
        // const vertexAI = new VertexAI({project: PROJECT_ID, location: LOCATION});
        // const model = vertexAI.getGenerativeModel({model: GENERATION_MODEL});

        //       const system = `You are an expert resume reviewer for software/tech roles.
        // Return STRICT JSON with the following schema:
        // {
        //   "summary": "2-4 sentences",
        //   "strengths": ["..."],
        //   "gaps": ["..."],
        //   "suggested_improvements": ["..."],
        //   "role_suggestions": ["..."],
        //   "keywords": {
        //     "skills": ["normalized technical skills"],
        //     "tools": ["frameworks/libraries"],
        //     "domains": ["areas like backend, ML, data"],
        //     "seniority": "Junior|Mid|Senior"
        //   }
        // }`;

        // const prompt = `Resume text:\n${text}\n\nGenerate the JSON now. Do not include explanations.`;

        // const resp = await model.generateContent({
        //   contents: [
        //     {role: "user", parts: [{text: system}]},
        //     {role: "user", parts: [{text: prompt}]},
        //   ],
        //   generationConfig: {responseMimeType: "application/json"},
        // });

        // const raw =
        //   resp.response?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        // let parsed;
        // try {
        //   parsed = JSON.parse(raw);
        // } catch {
        //   parsed = {rawText: raw};
        // }

        // 4) Save to Firestore alongside the file
        const fileID = object.metadata?.fileID; // Read fileID from custom metadata
        if (!fileID) {
          logger.error("File ID not found in metadata.");
          return;
        }

        // // await admin
        // //     .firestore()
        // //     .collection("file")
        // //     .doc(fileID)
        // //     .set(
        // //         {
        // //           feedback: parsed,
        // //           analysisAvailable: true,
        // //           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // //           model: GENERATION_MODEL,
        // //           sourcePath: filePath,
        // //           bucket: bucketName,
        // //         },
        // //         {merge: true}, // Added comma
        // //     );

        // const fileRef = admin.firestore().collection("file").doc(fileID);
        // await admin.firestore().runTransaction(async (transaction) => {
        //   const fileDoc = await transaction.get(fileRef);

        //   if (!fileDoc.exists) {
        //     logger.error(`File document not found for fileID: ${fileID}`);
        //     return;
        //   }

        //   const currentNumAnalysis = fileDoc.data().numAnalysis || 0;
        //   const newIdx = currentNumAnalysis + 1;
        //   const analysisID = `${fileID}-${newIdx}`;

        //   transaction.update(fileRef, {
        //     lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        //     numAnalysis: newIdx,
        //     [`analysis.${newIdx}`]: analysisID, // Add to `analysis` dict
        //   });

        //   // Add a new document to `collection('analysis')`
        //   const analysisRef = admin.firestore().collection("analysis").doc(analysisID);
        //   transaction.set(analysisRef, {
        //     owner: fileDoc.data().owner || object.metadata?.owner || "", // Ensure owner is set
        //     fileID: fileID,
        //     content: parsed, // Feedback JSON from Vertex AI
        //     generateTime: admin.firestore.FieldValue.serverTimestamp(),
        //     model: GENERATION_MODEL,
        //     userRating: null, // Initialize as null
        //     userComment: null, // Initialize as null
        //     nextAnalysis: null, // Initialize as null
        //   });
        // });

        // logger.info("Analysis saved in Firestore", {fileID, analysisID});

        await analyzeResumeText(resumeText, fileID, filePath); // , bucketName);

      } catch (e) {
        logger.error("onResumeUploaded error", e);
        throw e;
      }
      //   logger.info("Feedback saved in Firestore for file", {fileID, filePath});
      // } catch (e) {
      //   logger.error("onResumeUploaded error", e);
      //   throw e; // surface error to logs/metrics
      // }

    }, // Added comma
);

// ------------------------------------------------------------------ //
// ------------------------------------------------------------------ //
/* ----------------- New script for re-gen analysis ----------------- */
// ------------------------------------------------------------------ //
// ------------------------------------------------------------------ //
const {onRequest} = require("firebase-functions/v2/https");
const {FieldValue} = require("firebase-admin/firestore");
// const {VertexAI} = require("@google-cloud/vertexai");

exports.generateNewAnalysis = onRequest(async (req, res) => {
  try {
    // Step 1: Parse request data
    const {fileID, analysisID, userRating, userComment} = req.body;

    if (!fileID || !analysisID || !userRating || !userComment) {
      res.status(400).send({error: "Missing required parameters."});
      return;
    }

    // Step 2: Retrieve existing analysis data
    const analysisDoc = await admin.firestore().collection("analysis").doc(analysisID).get();
    if (!analysisDoc.exists) {
      res.status(404).send({error: "Analysis document not found."});
      return;
    }

    const analysisData = analysisDoc.data();

    // Step 3: Prepare the prompt for Vertex AI
    const vertexAI = new VertexAI({project: PROJECT_ID, location: LOCATION});
    const model = vertexAI.getGenerativeModel({model: GENERATION_MODEL});

    // New Add [A]
    const fileDoc = await admin.firestore().collection("file").doc(fileID).get();
    if (!fileDoc.exists) {
      res.status(404).send({error: "File document not found."});
      return;
    }
    const filePath = fileDoc.data().path; // Get the storage path
    if (!filePath) {
      res.status(400).send({error: "File path not found in document."});
      return;
    }

    const bucket = admin.storage().bucket(); // Uses default bucket
    const [buffer] = await bucket.file(filePath).download();
    const text = (await pdfParse(buffer)).text || "";
    // End of New Add [A]

    const system = `
You are an expert resume reviewer for software/tech roles.
Return STRICT JSON with the following schema:
{
  "summary": "2-4 sentences",
  "strengths": ["..."],
  "gaps": ["..."],
  "suggested_improvements": ["..."],
  "role_suggestions": ["..."],
  "keywords": {
    "skills": ["normalized technical skills"],
    "tools": ["frameworks/libraries"],
    "domains": ["areas like backend, ML, data"],
    "seniority": "Junior|Mid|Senior"
  }
}`;

    const prompt = `
Resume text:\n${text}\n\n

Here's the previous analysis:
${JSON.stringify(analysisData.content)}

The user provided the following feedback:
- Rating: ${userRating}/5
- Comment: ${userComment}

Generate the JSON now. Do not include explanations.`;

    // const response = await model.generateText({content: prompt});
    // const response = await model.generateContent({content: prompt});
    const response = await model.generateContent({
      contents: [
        {role: "user", parts: [{text: system}]},
        {role: "user", parts: [{text: prompt}]},
      ],
      generationConfig: {responseMimeType: "application/json"},
    });

    // const newContent = JSON.parse(response.content); // Parse the new analysis JSON
    const raw =
      response.response?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {rawText: raw};
    }

    // Step 4: Update Firestore with the new analysis
    const fileRef = admin.firestore().collection("file").doc(fileID);
    // const fileDoc = await fileRef.get(); // Removed w/ New Add [A]

    if (!fileDoc.exists) {
      res.status(404).send({error: "File document not found."});
      return;
    }

    const numAnalysis = fileDoc.data().numAnalysis || 0;
    const newIndex = numAnalysis + 1;
    const newAnalysisID = `${fileID}-${newIndex}`;

    // Run Firestore updates in a transaction
    await admin.firestore().runTransaction(async (transaction) => {
      // Update `file` document
      transaction.update(fileRef, {
        lastUpdate: FieldValue.serverTimestamp(),
        numAnalysis: newIndex,
        [`analysis.${newIndex}`]: newAnalysisID,
      });

      // Add new analysis document
      const newAnalysisRef = admin.firestore().collection("analysis").doc(newAnalysisID);
      transaction.set(newAnalysisRef, {
        owner: fileDoc.data().owner,
        fileID: fileID,
        // content: newContent,
        content: parsed,
        generateTime: FieldValue.serverTimestamp(),
        model: GENERATION_MODEL,
        userRating: null, // Initially null
        userComment: null, // Initially null
        nextAnalysis: null, // Initially null
      });

      // Update the `nextAnalysis` field in the previous analysis
      transaction.update(admin.firestore().collection("analysis").doc(analysisID), {
        nextAnalysis: newAnalysisID,
      });
    });

    // Step 5: Respond to the frontend
    res.status(200).send({newAnalysisID});

  } catch (error) {
    console.error("Detailed error:", error.message, error.stack);
    res.status(500).send({error: error.message});
  }
});

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* ------------------- New script for gen resumes ------------------- */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
exports.generatePdf = onRequest(async (req, res) => {
  try {
    // Step 1: Parse request data with structured resume fields
    const {
      name, phone, email, summary, education, workExperience, projectExperience,
      skills, publications, title, pageSize, margins, fontFamily, lineHeight,
      headerHtml, footerHtml, pageNumbers, userId, resumeId, versionId,
    } = req.body;

    if (!userId || (!name && !summary)) {
      res.status(400).send({error: "Missing required parameters: userId and resume content (name or summary)."});
      return;
    }

    // Step 2: Format the resume text from structured data
    let resumeText = "";

    if (name) resumeText += `${name}\n`;
    if (phone) resumeText += `Phone: ${phone}\n`;
    if (email) resumeText += `Email: ${email}\n\n`;

    if (summary) resumeText += `SUMMARY\n${summary}\n\n`;

    if (education && education.length > 0) {
      resumeText += `EDUCATION\n`;
      education.forEach((edu) => {
        resumeText += `${edu.schoolName || ""} - ${edu.duration || ""}\n`;
        if (edu.descriptions && edu.descriptions.length > 0) {
          edu.descriptions.forEach((desc) => resumeText += `• ${desc}\n`);
        }
        resumeText += `\n`;
      });
    }

    if (workExperience && workExperience.length > 0) {
      resumeText += `WORK EXPERIENCE\n`;
      workExperience.forEach((work) => {
        resumeText += `${work.company || ""} - ${work.position || ""} (${work.duration || ""})\n`;
        if (work.descriptions && work.descriptions.length > 0) {
          work.descriptions.forEach((desc) => resumeText += `• ${desc}\n`);
        }
        resumeText += `\n`;
      });
    }

    if (projectExperience && projectExperience.length > 0) {
      resumeText += `PROJECTS\n`;
      projectExperience.forEach((project) => {
        resumeText += `${project.name || ""} - ${project.duration || ""}\n`;
        if (project.descriptions && project.descriptions.length > 0) {
          project.descriptions.forEach((desc) => resumeText += `• ${desc}\n`);
        }
        resumeText += `\n`;
      });
    }

    if (skills && skills.length > 0) {
      resumeText += `SKILLS\n${skills.join(", ")}\n\n`;
    }

    if (publications && publications.length > 0) {
      resumeText += `PUBLICATIONS\n`;
      publications.forEach((pub) => resumeText += `• ${pub}\n`);
    }

    // Step 3: Set up Vertex AI with MCP tool integration
    const vertexAI = new VertexAI({project: PROJECT_ID, location: LOCATION});
    const model = vertexAI.getGenerativeModel({model: GENERATION_MODEL});

    const systemPrompt = `You have access to a tool named txt_to_pdf that renders plain text to a styled PDF and returns a URL.
When a user asks to export a resume or convert text to PDF, call txt_to_pdf with sensible defaults:
- pageSize: "Letter" in the US, "A4" elsewhere
- margins: "36px"
- pageNumbers: true
- title: a short, descriptive title (e.g., "Resume - John Doe")
Return the pdf_url to the user and store the metadata to Firestore.

Available tool: txt_to_pdf
Tool schema: {
  "type": "object",
  "properties": {
    "text": {"type": "string", "description": "Plain English text to render"},
    "title": {"type": "string", "default": "Resume"},
    "pageSize": {"type": "string", "enum": ["A4","Letter"], "default": "Letter"},
    "margins": {"type": "string", "description": "CSS-like, e.g. '36px 36px 48px 36px'", "default": "36px"},
    "fontFamily": {"type": "string", "default": "Inter, system-ui, -apple-system, Arial, sans-serif"},
    "lineHeight": {"type": "number", "default": 1.5},
    "headerHtml": {"type": "string", "description": "Optional HTML for header/footer"},
    "footerHtml": {"type": "string"},
    "pageNumbers": {"type": "boolean", "default": true}
  },
  "required": ["text"]
}`;

    const userPrompt = `Please convert this structured resume to PDF:
Name: ${name || "N/A"}
Phone: ${phone || "N/A"}
Email: ${email || "N/A"}
Summary: ${summary || "N/A"}
Education: ${education ? JSON.stringify(education) : "N/A"}
Work Experience: ${workExperience ? JSON.stringify(workExperience) : "N/A"}
Project Experience: ${projectExperience ? JSON.stringify(projectExperience) : "N/A"}
Skills: ${skills ? skills.join(", ") : "N/A"}
Publications: ${publications ? JSON.stringify(publications) : "N/A"}

Full text format:
${resumeText}

Title: ${title || "Resume"}
Page size: ${pageSize || "Letter"}
Margins: ${margins || "36px"}
Page numbers: ${pageNumbers !== false}`;

    const response = await model.generateContent({
      contents: [
        {role: "user", parts: [{text: systemPrompt}]},
        {role: "user", parts: [{text: userPrompt}]},
      ],
      generationConfig: {responseMimeType: "application/json"},
    });

    const raw = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let aiResponse;
    try {
      aiResponse = JSON.parse(raw);
    } catch {
      aiResponse = {rawText: raw};
    }

    // Step 4: Generate timestamp for file naming
    const now = new Date();
    const timestamp = now.toISOString()
        .replace(/:/g, "-")
        .replace(/\./g, "-")
        .replace("T", "-")
        .replace("Z", "");

    const pdfTitle = title || "Resume";
    const fileName = `${pdfTitle}-${timestamp}.pdf`;
    const filePath = `${userId}/${fileName}`;

    // Step 5: Call Vertex AI and MCP server
    // const mcpServerUrl = process.env.MCP_SERVER_URL;
    // const response = await model.generateContent({
    //   contents: [
    //     {role: "user", parts: [{text: systemPrompt}]},
    //     {role: "user", parts: [{text: userPrompt}]},
    //   ],
    //   generationConfig: {responseMimeType: "application/json"},
    // });

    const mcpPayload = {
      text: aiResponse.enhanced_text || resumeText, // resumeText,
      title: pdfTitle,
      pageSize: pageSize || "Letter",
      margins: margins || "36px",
      fontFamily: fontFamily || "Inter, system-ui, -apple-system, Arial, sans-serif",
      lineHeight: lineHeight || 1.5,
      headerHtml: headerHtml || "",
      footerHtml: footerHtml || "",
      pageNumbers: pageNumbers !== false,
    };

    // Step 6: Call MCP server directly
    // const pdfServiceUrl = process.env.PDF_SERVICE_URL || "https://mcp-server-636025066641.us-west1.run.app/tools/txt_to_pdf";
    const pdfServiceUrl = "https://mcp-server-636025066641.us-west1.run.app/";

    const fetch = require("node-fetch");
    const pdfResponse = await fetch(pdfServiceUrl, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(mcpPayload),
    });

    if (!pdfResponse.ok) {
      const errorText = await pdfResponse.text();
      logger.error("PDF generation failed", errorText);
      res.status(500).send({error: "PDF generation failed", detail: errorText});
      return;
    }

    const pdfData = await pdfResponse.json();

    // Step 7: Download PDF from the generated URL and save to Firebase Storage
    const pdfBuffer = await fetch(pdfData.pdf_url).then((res) => res.buffer());

    const bucket = admin.storage().bucket();
    const file = bucket.file(filePath);

    await file.save(pdfBuffer, {
      metadata: {
        contentType: "application/pdf",
        metadata: {
          owner: userId,
          originalTitle: pdfTitle,
          generatedAt: now.toISOString(),
        },
      },
    });

    logger.info(`PDF saved to Firebase Storage: ${filePath}`);

    // // Step 8: Update Firestore with new file record
    // await admin.firestore().runTransaction(async (transaction) => {
    //   // Generate unique fileID
    //   const fileRef = admin.firestore().collection("file").doc();
    //   const fileID = fileRef.id;

    //   // Create file document
    //   transaction.set(fileRef, {
    //     analysis: [],
    //     filename: pdfTitle,
    //     lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
    //     numAnalysis: 0,
    //     owner: userId,
    //     path: filePath,
    //     type: "Generated",
    //     uploadDate: admin.firestore.FieldValue.serverTimestamp(),
    //   });

    //   // Update user's files list
    //   const userRef = admin.firestore().collection("user").doc(userId);
    //   transaction.update(userRef, {
    //     files: admin.firestore.FieldValue.arrayUnion(fileID),
    //   });

    //   // If resumeId and versionId provided, also update version metadata
    //   if (resumeId && versionId) {
    //     const versionRef = admin.firestore()
    //         .collection("users")
    //         .doc(userId)
    //         .collection("resumes")
    //         .doc(resumeId)
    //         .collection("versions")
    //         .doc(versionId);

    //     transaction.set(versionRef, {
    //       pdf_url: pdfData.pdf_url,
    //       gcs_uri: pdfData.gcs_uri,
    //       firebase_path: filePath,
    //       fileID: fileID,
    //       generated_at: admin.firestore.FieldValue.serverTimestamp(),
    //       page_count: pdfData.page_count || null,
    //       bytes: pdfData.bytes || null,
    //       title: pdfData.title,
    //       generation_params: mcpPayload,
    //     }, {merge: true});
    //   }
    // });

    let fileID;
    await admin.firestore().runTransaction(async (transaction) => {
      // Generate unique fileID
      const fileRef = admin.firestore().collection("file").doc();
      fileID = fileRef.id;

      // Create file document
      transaction.set(fileRef, {
        analysis: [],
        filename: pdfTitle,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        numAnalysis: 0,
        owner: userId,
        path: filePath,
        type: "Generated",
        uploadDate: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update user's files list
      const userRef = admin.firestore().collection("user").doc(userId);
      transaction.update(userRef, {
        files: admin.firestore.FieldValue.arrayUnion(fileID),
      });

      // If resumeId and versionId provided, also update version metadata
      if (resumeId && versionId) {
        const versionRef = admin.firestore()
            .collection("users")
            .doc(userId)
            .collection("resumes")
            .doc(resumeId)
            .collection("versions")
            .doc(versionId);

        transaction.set(versionRef, {
          pdf_url: pdfData.pdf_url,
          gcs_uri: pdfData.gcs_uri,
          firebase_path: filePath,
          fileID: fileID,
          generated_at: admin.firestore.FieldValue.serverTimestamp(),
          page_count: pdfData.page_count || null,
          bytes: pdfData.bytes || null,
          title: pdfData.title,
          generation_params: mcpPayload,
        }, {merge: true});
      }
    });

    try {
      await analyzeResumeText(resumeText, fileID, filePath, bucket.name);
      logger.info("Analysis completed for generated resume", {fileID});
    } catch (analysisError) {
      logger.error("Failed to analyze generated resume:", analysisError);
      // Don't fail the whole request if analysis fails
    }

    // Step 9: Return success response
    res.status(200).send({
      success: true,
      pdf_url: pdfData.pdf_url,
      firebase_path: filePath,
      gcs_uri: pdfData.gcs_uri,
      page_count: pdfData.page_count,
      bytes: pdfData.bytes,
      title: pdfData.title,
      rendered_at: pdfData.rendered_at,
      // fileID: fileRef.id, // Return the generated fileID
      fileID: fileID,
    });

  } catch (error) {
    logger.error("generatePdf error:", error);
    res.status(500).send({error: error.message});
  }
});
