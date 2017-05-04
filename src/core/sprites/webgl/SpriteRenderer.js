import ObjectRenderer from '../../renderers/webgl/utils/ObjectRenderer';
import WebGLRenderer from '../../renderers/webgl/WebGLRenderer';
import GLBuffer from '../../renderers/webgl/systems/geometry/GLBuffer';
import createIndicesForQuads from '../../utils/createIndicesForQuads';
import generateMultiTextureShader from './generateMultiTextureShader';
import checkMaxIfStatmentsInShader from '../../renderers/webgl/utils/checkMaxIfStatmentsInShader';
import Buffer from './BatchBuffer';
import settings from '../../settings';
import bitTwiddle from 'bit-twiddle';

let TICK = 0;
let TEXTURE_TICK = 0;

/**
 * Renderer dedicated to drawing and batching sprites.
 *
 * @class
 * @private
 * @memberof PIXI
 * @extends PIXI.ObjectRenderer
 */
export default class SpriteRenderer extends ObjectRenderer
{
    /**
     * @param {PIXI.WebGLRenderer} renderer - The renderer this sprite batch works for.
     */
    constructor(renderer)
    {
        super(renderer);

        /**
         * Number of values sent in the vertex buffer.
         * aVertexPosition(2), aTextureCoord(1), aColor(1), aTextureId(1) = 5
         *
         * @member {number}
         */
        this.vertSize = 5;

        /**
         * The size of the vertex information in bytes.
         *
         * @member {number}
         */
        this.vertByteSize = this.vertSize * 4;

        /**
         * The number of images in the SpriteRenderer before it flushes.
         *
         * @member {number}
         */
        this.size = settings.SPRITE_BATCH_SIZE; // 2000 is a nice balance between mobile / desktop

        // the total number of bytes in our batch
        // let numVerts = this.size * 4 * this.vertByteSize;

        this.buffers = [];
        for (let i = 1; i <= bitTwiddle.nextPow2(this.size); i *= 2)
        {
            this.buffers.push(new Buffer(i * 4 * this.vertByteSize));
        }

        /**
         * Holds the indices of the geometry (quads) to draw
         *
         * @member {Uint16Array}
         */
        this.indices = createIndicesForQuads(this.size);

        /**
         * The default shaders that is used if a sprite doesn't have a more specific one.
         * there is a shader for each number of textures that can be rendererd.
         * These shaders will also be generated on the fly as required.
         * @member {PIXI.Shader[]}
         */
        this.shader = null;

        this.currentIndex = 0;
        this.groups = [];

        for (let k = 0; k < this.size; k++)
        {
            this.groups[k] = { textures: [], textureCount: 0, ids: [], size: 0, start: 0, blend: 0 };
        }

        this.sprites = [];

        this.vertexBuffers = [];
        this.vaos = [];

        this.vaoMax = 2;
        this.vertexCount = 0;

        this.renderer.on('prerender', this.onPrerender, this);
    }

    /**
     * Sets up the renderer context and necessary buffers.
     *
     * @private
     */
    contextChange()
    {
        const gl = this.renderer.gl;

        if (this.renderer.legacy)
        {
            this.MAX_TEXTURES = 1;
        }
        else
        {
            // step 1: first check max textures the GPU can handle.
            this.MAX_TEXTURES = Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), settings.SPRITE_MAX_TEXTURES);

            // step 2: check the maximum number of if statements the shader can have too..
            this.MAX_TEXTURES = checkMaxIfStatmentsInShader(this.MAX_TEXTURES, gl);
        }

        const shader = this.shader = generateMultiTextureShader(gl, this.MAX_TEXTURES);

        const sampleValues = new Int32Array(this.MAX_TEXTURES);

        for (let i = 0; i < this.MAX_TEXTURES; i++)
        {
            sampleValues[i] = i;
        }

        shader.uniformGroup.add('default', {uSamplers:sampleValues}, true);//this.renderer.globalUniforms;
        shader.uniforms.globals = this.renderer.globalUniforms;

        this.indexBuffer = GLBuffer.createIndexBuffer(gl, this.indices, gl.STATIC_DRAW);

        // we use the second shader as the first one depending on your browser may omit aTextureId
        // as it is not used by the shader so is optimized out.

        this.renderer.geometry.bindVao(null);

        for (let i = 0; i < this.vaoMax; i++)
        {
            this.vertexBuffers[i] = GLBuffer.createVertexBuffer(gl, null, gl.DYNAMIC_DRAW);
            /* eslint-disable max-len */

            var attributeData = shader.program.attributeData;
            // build the vao object that will render..
            this.vaos[i] = this.renderer.geometry.createVao()
                .addIndex(this.indexBuffer)
                .addAttribute(this.vertexBuffers[i], attributeData.aVertexPosition, gl.FLOAT, false, this.vertByteSize, 0)
                .addAttribute(this.vertexBuffers[i], attributeData.aTextureCoord, gl.UNSIGNED_SHORT, true, this.vertByteSize, 2 * 4)
                .addAttribute(this.vertexBuffers[i], attributeData.aColor, gl.UNSIGNED_BYTE, true, this.vertByteSize, 3 * 4);

            if (attributeData.aTextureId)
            {
                this.vaos[i].addAttribute(this.vertexBuffers[i], attributeData.aTextureId, gl.FLOAT, false, this.vertByteSize, 4 * 4);
            }

            /* eslint-enable max-len */
        }

        this.vao = this.vaos[0];
        this.currentBlendMode = 99999;

        this.boundTextures = new Array(this.MAX_TEXTURES);
    }

    /**
     * Called before the renderer starts rendering.
     *
     */
    onPrerender()
    {
        this.vertexCount = 0;
    }

    /**
     * Renders the sprite object.
     *
     * @param {PIXI.Sprite} sprite - the sprite to render when using this spritebatch
     */
    render(sprite)
    {
        // TODO set blend modes..
        // check texture..
        if (this.currentIndex >= this.size)
        {
            this.flush();
        }

        // get the uvs for the texture

        // if the uvs have not updated then no point rendering just yet!
        if (!sprite._texture._uvs)
        {
            return;
        }

        // push a texture.
        // increment the batchsize
        this.sprites[this.currentIndex++] = sprite;
    }

    /**
     * Renders the content and empties the current batch.
     *
     */
    flush()
    {
        if (this.currentIndex === 0)
        {
            return;
        }

        const gl = this.renderer.gl;
        const MAX_TEXTURES = this.MAX_TEXTURES;

        const np2 = bitTwiddle.nextPow2(this.currentIndex);
        const log2 = bitTwiddle.log2(np2);
        const buffer = this.buffers[log2];

        const sprites = this.sprites;
        const groups = this.groups;

        const float32View = buffer.float32View;
        const uint32View = buffer.uint32View;

        const boundTextures = this.boundTextures;
        const rendererBoundTextures = this.renderer.boundTextures;
        const touch = 0//this.renderer.textureGC.count;

        let index = 0;
        let nextTexture;
        let currentTexture;
        let groupCount = 1;
        let textureId = 0;
        let textureCount = 0;
        let currentGroup = groups[0];
        let vertexData;
        let uvs;
        let blendMode = sprites[0].blendMode;

        currentGroup.textureCount = 0;
        currentGroup.start = 0;
        currentGroup.blend = blendMode;

        TICK++;

        let i;

        // copy textures..
        for (i = 0; i < MAX_TEXTURES; ++i)
        {
            boundTextures[i] = rendererBoundTextures[i];
            boundTextures[i]._virtalBoundId = i;
        }

        for (i = 0; i < this.currentIndex; ++i)
        {
            // upload the sprite elemetns...
            // they have all ready been calculated so we just need to push them into the buffer.

            // upload the sprite elemetns...
            // they have all ready been calculated so we just need to push them into the buffer.
            var sprite = sprites[i];

            nextTexture = sprite._texture.baseTexture;
            textureId = nextTexture._id;


            if(blendMode !== sprite.blendMode)
            {
                blendMode = sprite.blendMode;

                // force the batch to break!
                currentTexture = null;
                textureCount = this.MAX_TEXTURES;
                TICK++;
            }

            if(currentTexture !== nextTexture)
            {
                currentTexture = nextTexture;

                if(nextTexture._enabled !== TICK)
                {
                    if(textureCount === this.MAX_TEXTURES)
                    {
                        TICK++;

                        textureCount = 0;

                        currentGroup.size = i - currentGroup.start;

                        currentGroup = groups[groupCount++];
                        currentGroup.textureCount = 0;
                        currentGroup.blend = blendMode;
                        currentGroup.start = i;
                    }

                    nextTexture._enabled = TICK;
                    nextTexture._id = textureCount;

                    currentGroup.textures[currentGroup.textureCount++] = nextTexture;
                    textureCount++;
                }

            }

            vertexData = sprite.vertexData;

            // TODO this sum does not need to be set each frame..
            uvs = sprite._texture._uvs.uvsUint32;
            textureId = nextTexture._id;

            if (this.renderer.roundPixels)
            {
                const resolution = this.renderer.resolution;

                // xy
                float32View[index] = ((vertexData[0] * resolution) | 0) / resolution;
                float32View[index + 1] = ((vertexData[1] * resolution) | 0) / resolution;

                // xy
                float32View[index + 5] = ((vertexData[2] * resolution) | 0) / resolution;
                float32View[index + 6] = ((vertexData[3] * resolution) | 0) / resolution;

                // xy
                float32View[index + 10] = ((vertexData[4] * resolution) | 0) / resolution;
                float32View[index + 11] = ((vertexData[5] * resolution) | 0) / resolution;

                // xy
                float32View[index + 15] = ((vertexData[6] * resolution) | 0) / resolution;
                float32View[index + 16] = ((vertexData[7] * resolution) | 0) / resolution;
            }
            else
            {
                // xy
                float32View[index] = vertexData[0];
                float32View[index + 1] = vertexData[1];

                // xy
                float32View[index + 5] = vertexData[2];
                float32View[index + 6] = vertexData[3];

                // xy
                float32View[index + 10] = vertexData[4];
                float32View[index + 11] = vertexData[5];

                // xy
                float32View[index + 15] = vertexData[6];
                float32View[index + 16] = vertexData[7];
            }

            uint32View[index + 2] = uvs[0];
            uint32View[index + 7] = uvs[1];
            uint32View[index + 12] = uvs[2];
            uint32View[index + 17] = uvs[3];

            /* eslint-disable max-len */
            uint32View[index + 3] = uint32View[index + 8] = uint32View[index + 13] = uint32View[index + 18] = sprite._tintRGB + (Math.min(sprite.worldAlpha, 1) * 255 << 24);

            float32View[index + 4] = float32View[index + 9] = float32View[index + 14] = float32View[index + 19] = textureId;
            /* eslint-enable max-len */

            index += 20;
        }

        currentGroup.size = i - currentGroup.start;

        if (!settings.CAN_UPLOAD_SAME_BUFFER)
        {
            // this is still needed for IOS performance..
            // it really does not like uploading to the same buffer in a single frame!
            if (this.vaoMax <= this.vertexCount)
            {
                this.vaoMax++;
                this.vertexBuffers[this.vertexCount] = GLBuffer.createVertexBuffer(gl, null, gl.DYNAMIC_DRAW);

                /* eslint-disable max-len */

                var attributeData = this.shader.program.attributeData;

                // build the vao object that will render..
                this.vaos[this.vertexCount] = this.renderer.geometry.createVao()
                    .addIndex(this.indexBuffer)
                    .addAttribute(this.vertexBuffers[this.vertexCount], attributeData.aVertexPosition, gl.FLOAT, false, this.vertByteSize, 0)
                    .addAttribute(this.vertexBuffers[this.vertexCount], attributeData.aTextureCoord, gl.UNSIGNED_SHORT, true, this.vertByteSize, 2 * 4)
                    .addAttribute(this.vertexBuffers[this.vertexCount], attributeData.aColor, gl.UNSIGNED_BYTE, true, this.vertByteSize, 3 * 4);

                if (attributeData.aTextureId)
                {
                    this.vaos[this.vertexCount].addAttribute(this.vertexBuffers[this.vertexCount], attributeData.aTextureId, gl.FLOAT, false, this.vertByteSize, 4 * 4);
                }

                /* eslint-enable max-len */
            }

            this.renderer.geometry.bindVao(this.vaos[this.vertexCount]);

            this.vertexBuffers[this.vertexCount].upload(buffer.vertices, 0, false);

            this.vertexCount++;
        }
        else
        {
            // lets use the faster option, always use buffer number 0
            this.vertexBuffers[this.vertexCount].upload(buffer.vertices, 0, true);
        }

        /// render the groups..
        for (i = 0; i < groupCount; i++) {

            var group = groups[i];
            var groupTextureCount = group.textureCount;
            //shader = this.shaders[groupTextureCount-1];

            //if(!shader)
           // {
          //      shader = this.shaders[groupTextureCount-1] = generateMultiTextureShader(gl, groupTextureCount);
                //console.log("SHADER generated for " + textureCount + " textures")
            //}

          ///  this.renderer.shader.bind(shader);

            for (var j = 0; j < groupTextureCount; j++)
            {
                this.renderer.texture.bind(group.textures[j], j);
            }

            // set the blend mode..
            //this.renderer.state.setBlendMode( group.blend );

            gl.drawElements(gl.TRIANGLES, group.size * 6, gl.UNSIGNED_SHORT, group.start * 6 * 2);
        }
/*
        // render the groups..
        for (i = 0; i < groupCount; ++i)
        {
            const group = groups[i];
            const groupTextureCount = group.textureCount;

            for (let j = 0; j < groupTextureCount; j++)
            {
                currentTexture = group.textures[j];

                // reset virtual ids..
                // lets do a quick check..
                if (rendererBoundTextures[group.ids[j]] !== currentTexture)
                {
                    this.renderer.texture.bind(currentTexture, group.ids[j], true);
                }

                // reset the virtualId..
                currentTexture._virtalBoundId = -1;
            }

            // set the blend mode..
            this.renderer.state.setBlendMode(group.blend);

            gl.drawElements(gl.TRIANGLES, group.size * 6, gl.UNSIGNED_SHORT, group.start * 6 * 2);
        }
*/
        // reset elements for the next flush
        this.currentIndex = 0;
    }

    /**
     * Starts a new sprite batch.
     */
    start()
    {
       // this.renderer._bindGLShader(this.shader);
        this.renderer.shader.bind(this.shader, true);
        this.renderer.shader.syncUniformGroup(this.shader.uniformGroup);

        if (settings.CAN_UPLOAD_SAME_BUFFER)
        {
            // bind buffer #0, we don't need others
            this.renderer.geometry.bindVao(this.vaos[this.vertexCount]);

            this.vertexBuffers[this.vertexCount].bind();
        }
    }

    /**
     * Stops and flushes the current batch.
     *
     */
    stop()
    {
        this.flush();
    }

    /**
     * Destroys the SpriteRenderer.
     *
     */
    destroy()
    {
        for (let i = 0; i < this.vaoMax; i++)
        {
            if (this.vertexBuffers[i])
            {
                this.vertexBuffers[i].destroy();
            }
            if (this.vaos[i])
            {
                this.vaos[i].destroy();
            }
        }

        if (this.indexBuffer)
        {
            this.indexBuffer.destroy();
        }

        this.renderer.off('prerender', this.onPrerender, this);

        super.destroy();

        if (this.shader)
        {
            this.shader.destroy();
            this.shader = null;
        }

        this.vertexBuffers = null;
        this.vaos = null;
        this.indexBuffer = null;
        this.indices = null;

        this.sprites = null;

        for (let i = 0; i < this.buffers.length; ++i)
        {
            this.buffers[i].destroy();
        }
    }
}

WebGLRenderer.registerPlugin('sprite', SpriteRenderer);
